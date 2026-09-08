import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TabgradError,
  createRuntimeSession,
} from "../../dist/index.js";
import {
  createTestRuntimeSession,
  getTestExecutionFailureContext,
} from "../../dist/testing.js";
import { ExecutableProgram } from "../../dist/executable-program.js";

const distributionRoot = normalize(fileURLToPath(new URL("../../dist", import.meta.url)));
let server;
let distributionUrl;
const requestCounts = new Map();
const virtualResponses = new Map();

function assertNoLiveState(session) {
  assert.deepEqual(
    {
      liveAllocationBytes: session.diagnostics().liveAllocationBytes,
      liveMaterializationRecords: session.diagnostics().liveMaterializationRecords,
      liveOperationRecords: session.diagnostics().liveOperationRecords,
      liveRequestLeases: session.diagnostics().liveRequestLeases,
      liveTensorHandles: session.diagnostics().liveTensorHandles,
      liveTensorValues: session.diagnostics().liveTensorValues,
    },
    {
      liveAllocationBytes: 0,
      liveMaterializationRecords: 0,
      liveOperationRecords: 0,
      liveRequestLeases: 0,
      liveTensorHandles: 0,
      liveTensorValues: 0,
    },
  );
}

function unsignedLeb128(value) {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function signedLeb128(value) {
  const bytes = [];
  let remaining = value;
  while (true) {
    const byte = remaining & 0x7f;
    remaining >>= 7;
    const complete = (remaining === 0 && (byte & 0x40) === 0)
      || (remaining === -1 && (byte & 0x40) !== 0);
    bytes.push(complete ? byte : byte | 0x80);
    if (complete) {
      return bytes;
    }
  }
}

function encodedString(value) {
  const bytes = Buffer.from(value, "utf8");
  return [...unsignedLeb128(bytes.length), ...bytes];
}

function section(identifier, contents) {
  return [identifier, ...unsignedLeb128(contents.length), ...contents];
}

function fixtureModule({
  abiVersion = 1,
  arenaBase = 1_048_576,
  capabilities = 1,
  kernelBehavior = "success",
  memoryImportName = "memory",
  omitKernelExport = false,
} = {}) {
  const functionType = (parameters, results) => [
    0x60,
    ...unsignedLeb128(parameters.length),
    ...parameters,
    ...unsignedLeb128(results.length),
    ...results,
  ];
  const i32 = 0x7f;
  const types = section(1, [
    0x02,
    ...functionType([], [i32]),
    ...functionType([i32, i32, i32, i32], [i32]),
  ]);
  const imports = section(2, [
    0x01,
    ...encodedString("env"),
    ...encodedString(memoryImportName),
    0x02,
    0x01,
    ...unsignedLeb128(32),
    ...unsignedLeb128(1024),
  ]);
  const functions = section(3, [0x04, 0x00, 0x00, 0x00, 0x01]);
  const exportedFunctions = [
    ["tabgrad_abi_version", 0],
    ["tabgrad_capabilities", 1],
    ["tabgrad_arena_base", 2],
    ...(omitKernelExport ? [] : [["tabgrad_add_f32", 3]]),
  ];
  const exports = section(7, [
    ...unsignedLeb128(exportedFunctions.length),
    ...exportedFunctions.flatMap(([name, index]) => [
      ...encodedString(name),
      0x00,
      ...unsignedLeb128(index),
    ]),
  ]);
  const constantBody = (value) => {
    const instructions = [0x41, ...signedLeb128(value), 0x0b];
    const body = [0x00, ...instructions];
    return [...unsignedLeb128(body.length), ...body];
  };
  const kernelInstructions = kernelBehavior === "trap"
    ? [0x00, 0x0b]
    : [0x41, ...signedLeb128(kernelBehavior === "status" ? 7 : 0), 0x0b];
  const kernelBody = [0x00, ...kernelInstructions];
  const code = section(10, [
    0x04,
    ...constantBody(abiVersion),
    ...constantBody(capabilities),
    ...constantBody(arenaBase),
    ...unsignedLeb128(kernelBody.length),
    ...kernelBody,
  ]);
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...types,
    ...imports,
    ...functions,
    ...exports,
    ...code,
  ]);
}

function installFixture(name, moduleOptions = {}, manifestTransform = (value) => value) {
  const modulePath = `/fixture-${name}.wasm`;
  const manifestPath = `/fixture-${name}.json`;
  const bytes = fixtureModule(moduleOptions);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const variant = (id, requiredFeatures) => ({
    id,
    path: modulePath.slice(1),
    sha256: hash,
    byteLength: bytes.byteLength,
    requiredFeatures,
  });
  const manifest = manifestTransform({
    schemaVersion: 1,
    moduleVersion: 1,
    abiVersion: 1,
    addressWidth: 32,
    sharedMemory: false,
    capabilities: ["add-f32"],
    imports: [{ module: "env", name: "memory", kind: "memory" }],
    memory: { initialPages: 32, maximumPages: 1024, alignment: 16 },
    variants: [variant("scalar", []), variant("simd128", ["simd128"])],
  });
  virtualResponses.set(modulePath, {
    body: bytes,
    contentType: "application/wasm",
  });
  virtualResponses.set(manifestPath, {
    body: Buffer.from(`${JSON.stringify(manifest)}\n`),
    contentType: "application/json",
  });
  return new URL(manifestPath.slice(1), distributionUrl);
}

before(async () => {
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);
      const virtualResponse = virtualResponses.get(pathname);
      if (virtualResponse !== undefined) {
        if (virtualResponse.waitFor !== undefined) {
          await virtualResponse.waitFor;
        }
        response.writeHead(200, { "content-type": virtualResponse.contentType })
          .end(virtualResponse.body);
        return;
      }
      const path = join(distributionRoot, pathname);
      const pathFromRoot = relative(distributionRoot, path);
      if (
        pathFromRoot === ".."
        || pathFromRoot.startsWith(`..${sep}`)
        || isAbsolute(pathFromRoot)
      ) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(path);
      const contentType = extname(path) === ".wasm"
        ? "application/wasm"
        : extname(path) === ".json"
          ? "application/json"
          : "text/javascript";
      response.writeHead(200, { "content-type": contentType }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  distributionUrl = `http://127.0.0.1:${address.port}/`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test("records float32 addition lazily and materializes it on observation", async () => {
  requestCounts.clear();
  const session = createTestRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl),
    forceVariant: "scalar",
  });
  const left = session.tensor([1, 2, 3]);
  const right = session.tensor([4, 5, 6]);
  const result = left.add(right);

  assert.deepEqual(result.shape, [3]);
  assert.equal(result.dtype, "float32");
  assert.deepEqual(session.diagnostics(), {
    backendLoads: 0,
    hostToWasmBytes: 0,
    hostToWasmCopies: 0,
    wasmToHostBytes: 0,
    wasmToHostCopies: 0,
    kernelCalls: 0,
    liveMaterializationRecords: 2,
    liveAllocationBytes: 0,
    liveOperationRecords: 1,
    liveRequestLeases: 0,
    liveTensorHandles: 3,
    liveTensorValues: 3,
    highWaterAllocationBytes: 0,
    highWaterReservedAllocationBytes: 0,
    reservedAllocationBytes: 0,
    selectedVariant: null,
    wasmMemoryBytes: 0,
    timings: {
      compilationMilliseconds: 0,
      instantiationMilliseconds: 0,
      integrityCheckMilliseconds: 0,
      manifestFetchMilliseconds: 0,
      moduleFetchMilliseconds: 0,
    },
  });
  assert.equal(requestCounts.size, 0);

  assert.deepEqual(Array.from(await result.toArray()), [5, 7, 9]);
  const afterObservation = session.diagnostics();
  const { timings, ...afterCounters } = afterObservation;
  assert.deepEqual(afterCounters, {
    backendLoads: 1,
    hostToWasmBytes: 24,
    hostToWasmCopies: 2,
    wasmToHostBytes: 12,
    wasmToHostCopies: 1,
    kernelCalls: 1,
    liveMaterializationRecords: 3,
    liveAllocationBytes: 36,
    liveOperationRecords: 1,
    liveRequestLeases: 0,
    liveTensorHandles: 3,
    liveTensorValues: 3,
    highWaterAllocationBytes: 36,
    highWaterReservedAllocationBytes: 48,
    reservedAllocationBytes: 48,
    selectedVariant: "scalar",
    wasmMemoryBytes: 2_097_152,
  });
  for (const duration of Object.values(timings)) {
    assert.equal(typeof duration, "number");
    assert.ok(duration >= 0);
  }
  assert.equal(requestCounts.get("/manifest.json"), 1);
  assert.equal(requestCounts.get("/wasm/add-f32-scalar.wasm"), 1);
  assert.equal(requestCounts.get("/wasm/add-f32-simd128.wasm"), undefined);

  left.close();
  right.close();
  result.close();
  await session.close();
  assertNoLiveState(session);
});

test("uses the fixed-vector module when that compatible variant is selected", async () => {
  const session = createTestRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl),
    forceVariant: "simd128",
  });
  const left = session.tensor([1, 2, 3, 4, 5]);
  const right = session.tensor([5, 4, 3, 2, 1]);
  const result = left.add(right);

  assert.deepEqual(Array.from(await result.toArray()), [6, 6, 6, 6, 6]);
  assert.equal(session.diagnostics().selectedVariant, "simd128");
  assert.equal(session.diagnostics().kernelCalls, 1);

  left.close();
  right.close();
  result.close();
  await session.close();
});

test("takes one capability snapshot for automatic module selection", async () => {
  const originalValidate = WebAssembly.validate;
  let validationCalls = 0;
  WebAssembly.validate = (bytes) => {
    validationCalls += 1;
    return originalValidate(bytes);
  };
  const session = createRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl),
  });
  try {
    const result = session.tensor([1]).add(session.tensor([2]));
    assert.deepEqual(Array.from(await result.toArray()), [3]);
    assert.equal(session.diagnostics().selectedVariant, "simd128");
    assert.equal(validationCalls, 1);
  } finally {
    WebAssembly.validate = originalValidate;
    await session.close();
  }
});

test("selects the scalar module when the capability snapshot lacks SIMD", async () => {
  const originalValidate = WebAssembly.validate;
  WebAssembly.validate = () => false;
  const session = createRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl),
  });
  try {
    const result = session.tensor([1]).add(session.tensor([2]));
    assert.deepEqual(Array.from(await result.toArray()), [3]);
    assert.equal(session.diagnostics().selectedVariant, "scalar");
  } finally {
    WebAssembly.validate = originalValidate;
    await session.close();
  }
});

test("keeps input values alive after their public handles close", async () => {
  const session = createRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl),
  });
  const left = session.tensor([1, 2]);
  const right = session.tensor([3, 4]);
  const result = left.add(right);
  left.close();
  right.close();

  assert.deepEqual(Array.from(await result.toArray()), [4, 6]);
  assert.equal(session.diagnostics().selectedVariant, "simd128");

  result.close();
  await session.close();
});

test("rejects unsupported operations synchronously during admission", async () => {
  const session = createRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl),
  });
  const two = session.tensor([1, 2]);
  const three = session.tensor([1, 2, 3]);
  const closed = session.tensor([1, 2]);
  closed.close();

  assert.throws(
    () => two.add(three),
    (error) => error instanceof TabgradError
      && error.code === "SHAPE_MISMATCH"
      && error.details.operation === "add"
      && error.details.contract === "equal-shape",
  );
  assert.throws(
    () => two.add(closed),
    (error) => error instanceof TabgradError
      && error.code === "CLOSED_TENSOR"
      && error.details.operation === "add"
      && error.details.contract === "open-input",
  );
  assert.throws(
    () => two.add({}),
    (error) => error instanceof TabgradError
      && error.code === "INVALID_TENSOR"
      && error.details.operation === "add"
      && error.details.contract === "tensor-handle",
  );
  assert.throws(
    () => session.tensor([1], { dtype: "float64" }),
    (error) => error instanceof TabgradError
      && error.code === "UNSUPPORTED_DTYPE"
      && error.details.operation === "tensor"
      && error.details.contract === "float32-dtype",
  );
  assert.throws(
    () => session.tensor([1], { device: "webgpu" }),
    (error) => error instanceof TabgradError
      && error.code === "UNSUPPORTED_DEVICE"
      && error.details.operation === "tensor"
      && error.details.contract === "cpu-device",
  );
  assert.throws(
    () => session.tensor([1], { layout: "strided" }),
    (error) => error instanceof TabgradError
      && error.code === "UNSUPPORTED_LAYOUT"
      && error.details.operation === "tensor"
      && error.details.contract === "contiguous-layout",
  );
  assert.throws(
    () => session.tensor([1, 2], { shape: [1, 2] }),
    (error) => error instanceof TabgradError && error.code === "INVALID_SHAPE",
  );
  assert.throws(
    () => session.tensor(null),
    (error) => error instanceof TabgradError && error.code === "INVALID_DATA",
  );

  const otherSession = createRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl),
  });
  const other = otherSession.tensor([1, 2]);
  assert.throws(
    () => two.add(other),
    (error) => error instanceof TabgradError && error.code === "DIFFERENT_SESSION",
  );

  two.close();
  three.close();
  other.close();
  await otherSession.close();
  await session.close();
  assert.throws(
    () => session.tensor([1]),
    (error) => error instanceof TabgradError && error.code === "CLOSED_SESSION",
  );
});

test("rejects nonnumeric JavaScript tensor data instead of coercing it", async () => {
  const session = createRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl),
  });

  try {
    for (const data of [
      7,
      "abc",
      [1, "2"],
      { length: 2, 0: "1", 1: {} },
    ]) {
      assert.throws(
        () => session.tensor(data),
        (error) => error instanceof TabgradError
          && error.code === "INVALID_DATA"
          && error.details.operation === "tensor"
          && error.details.contract === "numeric-data",
      );
    }
    assertNoLiveState(session);
    assert.equal(session.diagnostics().backendLoads, 0);
  } finally {
    await session.close();
  }
});

for (const [name, shape] of [
  ["null", null],
  ["array-like object", { length: 1, 0: 1 }],
  ["non-collection number", 7],
]) {
  test(`rejects malformed shape option: ${name}`, async () => {
    const session = createRuntimeSession({
      manifestUrl: new URL("manifest.json", distributionUrl),
    });
    try {
      assert.throws(
        () => session.tensor([1], { shape }),
        (error) => error instanceof TabgradError
          && error.code === "INVALID_SHAPE"
          && error.details.operation === "tensor"
          && error.details.contract === "one-dimensional-shape",
      );
      assert.equal(session.diagnostics().backendLoads, 0);
    } finally {
      await session.close();
    }
  });
}

test("copies numeric iterable and array-like tensor inputs", async () => {
  const session = createTestRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl),
    forceVariant: "scalar",
  });
  const iterable = {
    *[Symbol.iterator]() {
      yield 1.25;
      yield 2.5;
    },
  };
  const arrayLike = { length: 2, 0: 3.75, 1: 5 };

  try {
    const left = session.tensor(iterable);
    const right = session.tensor(arrayLike);
    arrayLike[0] = 100;
    const result = left.add(right);

    assert.deepEqual(Array.from(await result.toArray()), [5, 7.5]);
  } finally {
    await session.close();
  }
  assertNoLiveState(session);
});

test("reports artifact failures without falling back to JavaScript arithmetic", async () => {
  const session = createRuntimeSession({
    manifestUrl: new URL("missing.json", distributionUrl),
  });
  const result = session.tensor([1]).add(session.tensor([2]));

  await assert.rejects(
    result.toArray(),
    (error) => error instanceof TabgradError && error.code === "BACKEND_LOAD_FAILED",
  );
  assert.equal(session.diagnostics().kernelCalls, 0);
  await session.close();
  assertNoLiveState(session);
});

test("reuses released allocations instead of growing live memory", async () => {
  const session = createTestRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl),
    forceVariant: "scalar",
  });

  for (let index = 0; index < 20; index += 1) {
    const left = session.tensor([1, 2, 3, 4]);
    const right = session.tensor([4, 3, 2, 1]);
    const result = left.add(right);
    await result.toArray();
    left.close();
    right.close();
    result.close();
  }

  assert.equal(session.diagnostics().liveAllocationBytes, 0);
  assert.equal(session.diagnostics().highWaterAllocationBytes, 48);
  assert.equal(session.diagnostics().liveMaterializationRecords, 0);
  assert.equal(session.diagnostics().liveOperationRecords, 0);
  assert.equal(session.diagnostics().liveRequestLeases, 0);
  assert.equal(session.diagnostics().liveTensorHandles, 0);
  assert.equal(session.diagnostics().liveTensorValues, 0);
  await session.close();
});

test("drains an accepted observation when the session closes", async () => {
  const session = createTestRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl),
    forceVariant: "scalar",
  });
  const result = session.tensor([1, 2]).add(session.tensor([3, 4]));
  const observation = result.toArray();
  assert.equal(session.diagnostics().liveRequestLeases, 1);
  const closing = session.close();

  assert.deepEqual(Array.from(await observation), [4, 6]);
  await closing;
  assert.throws(
    () => result.toArray(),
    (error) => error instanceof TabgradError && error.code === "CLOSED_TENSOR",
  );
  assert.equal(session.diagnostics().liveAllocationBytes, 0);
});

test("all concurrent close calls wait for the same terminal drain", async () => {
  let releaseManifest;
  const manifestGate = new Promise((resolve) => {
    releaseManifest = resolve;
  });
  const manifestUrl = installFixture("concurrent-close");
  virtualResponses.get(manifestUrl.pathname).waitFor = manifestGate;
  const session = createTestRuntimeSession({
    manifestUrl,
    forceVariant: "scalar",
  });
  const result = session.tensor([1, 2]).add(session.tensor([3, 4]));
  const observation = result.toArray();
  const firstClosing = session.close();
  const secondClosing = session.close();
  let secondCloseSettled = false;
  secondClosing.then(() => {
    secondCloseSettled = true;
  });

  await Promise.resolve();
  await Promise.resolve();
  const settledBeforeDrain = secondCloseSettled;
  releaseManifest();
  await observation;
  await firstClosing;
  await secondClosing;

  assert.equal(settledBeforeDrain, false);
  assertNoLiveState(session);
});

test("discards unreachable pure work without loading the backend", async () => {
  const session = createRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl),
  });
  const left = session.tensor([1]);
  const right = session.tensor([2]);
  const result = left.add(right);
  left.close();
  right.close();
  result.close();

  assert.equal(session.diagnostics().backendLoads, 0);
  await session.close();
  assert.equal(session.diagnostics().backendLoads, 0);
});

test("ExecutableProgram is immutable and contains only logical slots", () => {
  const program = new ExecutableProgram(
    [
      { slot: 0, dtype: "float32", device: "cpu", layout: "contiguous", shape: [1], source: "binding", provenance: { operation: "tensor", source: "RuntimeSession.tensor" } },
      { slot: 1, dtype: "float32", device: "cpu", layout: "contiguous", shape: [1], source: "binding", provenance: { operation: "tensor", source: "RuntimeSession.tensor" } },
      { slot: 2, dtype: "float32", device: "cpu", layout: "contiguous", shape: [1], source: "computed", provenance: { operation: "add", source: "Tensor.add" } },
    ],
    [{ kind: "add-f32", left: 0, right: 1, output: 2, provenance: { operation: "add", source: "Tensor.add" } }],
    2,
  );

  assert.ok(Object.isFrozen(program));
  assert.ok(Object.isFrozen(program.values));
  assert.ok(Object.isFrozen(program.values[0].shape));
  assert.ok(Object.isFrozen(program.values[0].provenance));
  assert.ok(Object.isFrozen(program.computations));
  assert.ok(Object.isFrozen(program.computations[0].provenance));
  assert.deepEqual(Object.keys(program).sort(), [
    "computations",
    "domain",
    "formatVersion",
    "result",
    "values",
  ]);
  assert.doesNotMatch(JSON.stringify(program), /offset|pointer|module|Float32Array/);
});

test("lowering an admitted addition forms the inspected ExecutableProgram", async () => {
  let observedProgram;
  const session = createTestRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl),
    forceVariant: "scalar",
    onProgramFormed(program) {
      observedProgram = program;
    },
  });
  const result = session.tensor([1, 2]).add(session.tensor([3, 4]));

  assert.deepEqual(Array.from(await result.toArray()), [4, 6]);
  assert.ok(observedProgram instanceof ExecutableProgram);
  assert.ok(Object.isFrozen(observedProgram));
  assert.deepEqual(observedProgram.values, [
    {
      slot: 0,
      dtype: "float32",
      device: "cpu",
      layout: "contiguous",
      shape: [2],
      source: "binding",
      provenance: { operation: "tensor", source: "RuntimeSession.tensor" },
    },
    {
      slot: 1,
      dtype: "float32",
      device: "cpu",
      layout: "contiguous",
      shape: [2],
      source: "binding",
      provenance: { operation: "tensor", source: "RuntimeSession.tensor" },
    },
    {
      slot: 2,
      dtype: "float32",
      device: "cpu",
      layout: "contiguous",
      shape: [2],
      source: "computed",
      provenance: { operation: "add", source: "Tensor.add" },
    },
  ]);
  assert.deepEqual(observedProgram.computations, [
    {
      kind: "add-f32",
      left: 0,
      right: 1,
      output: 2,
      provenance: { operation: "add", source: "Tensor.add" },
    },
  ]);
  assert.equal(observedProgram.result, 2);
  assert.doesNotMatch(
    JSON.stringify(observedProgram),
    /offset|pointer|module|Float32Array/,
  );
  await session.close();
});

test("a preparation failure retains operation, program, backend, phase, and cause", async () => {
  let observedProgram;
  const session = createTestRuntimeSession({
    manifestUrl: new URL("missing-causal-context.json", distributionUrl),
    forceVariant: "scalar",
    onProgramFormed(program) {
      observedProgram = program;
    },
  });
  const result = session.tensor([1]).add(session.tensor([2]));
  let caught;
  try {
    await result.toArray();
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof TabgradError);
  assert.equal(caught.code, "BACKEND_LOAD_FAILED");
  const context = getTestExecutionFailureContext(caught);
  assert.ok(context);
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.provenance));
  assert.ok(Object.isFrozen(context.backendEndpoints));
  assert.equal(caught.details.backend, "webassembly-cpu");
  assert.equal(caught.details.phase, "manifest-fetch");
  assert.equal(context.operation, "add");
  assert.deepEqual(context.provenance, { operation: "add", source: "Tensor.add" });
  assert.equal(context.program, observedProgram);
  assert.equal(context.executionDomain, "webassembly-cpu");
  assert.deepEqual(context.backendEndpoints, ["webassembly-cpu"]);
  assert.equal(context.phase, "manifest-fetch");
  assert.ok(caught.cause instanceof Error);
  await session.close();
});

test("a kernel trap retains operation, program, backend, phase, and native cause", async () => {
  const manifestUrl = installFixture("causal-kernel-trap", {
    kernelBehavior: "trap",
  });
  let observedProgram;
  const session = createTestRuntimeSession({
    manifestUrl,
    forceVariant: "scalar",
    onProgramFormed(program) {
      observedProgram = program;
    },
  });
  const result = session.tensor([1]).add(session.tensor([2]));
  let caught;
  try {
    await result.toArray();
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof TabgradError);
  assert.equal(caught.code, "BACKEND_TRAP");
  const context = getTestExecutionFailureContext(caught);
  assert.ok(context);
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.provenance));
  assert.ok(Object.isFrozen(context.backendEndpoints));
  assert.equal(caught.details.backend, "webassembly-cpu");
  assert.equal(caught.details.phase, "execution");
  assert.equal(context.operation, "add");
  assert.deepEqual(context.provenance, { operation: "add", source: "Tensor.add" });
  assert.equal(context.program, observedProgram);
  assert.equal(context.executionDomain, "webassembly-cpu");
  assert.deepEqual(context.backendEndpoints, ["webassembly-cpu"]);
  assert.equal(context.phase, "execution");
  assert.ok(caught.cause instanceof WebAssembly.RuntimeError);
  await session.close();
});

test("a cached preparation failure keeps invocation contexts distinct", async () => {
  const observedPrograms = [];
  const session = createTestRuntimeSession({
    manifestUrl: new URL("missing-distinct-context.json", distributionUrl),
    forceVariant: "scalar",
    onProgramFormed(program) {
      observedPrograms.push(program);
    },
  });
  const first = session.tensor([1]).add(session.tensor([2]));
  const second = session.tensor([3]).add(session.tensor([4]));
  const caught = [];
  for (const result of [first, second]) {
    try {
      await result.toArray();
    } catch (error) {
      caught.push(error);
    }
  }

  assert.equal(caught.length, 2);
  assert.notEqual(caught[0], caught[1]);
  assert.equal(
    getTestExecutionFailureContext(caught[0]).program,
    observedPrograms[0],
  );
  assert.equal(
    getTestExecutionFailureContext(caught[1]).program,
    observedPrograms[1],
  );
  await session.close();
});

test("executes a finite chain in dependency order and handles empty tensors", async () => {
  const session = createTestRuntimeSession({
    manifestUrl: new URL("manifest.json", distributionUrl),
    forceVariant: "scalar",
  });
  const first = session.tensor([1, 2, 3]);
  const second = session.tensor([4, 5, 6]);
  const third = session.tensor([7, 8, 9]);
  const chained = first.add(second).add(third);
  const empty = session.tensor([]).add(session.tensor([]));

  assert.deepEqual(Array.from(await chained.toArray()), [12, 15, 18]);
  assert.deepEqual(Array.from(await empty.toArray()), []);
  assert.equal(session.diagnostics().kernelCalls, 3);
  await session.close();
});

test("the raw ABI rejects invalid ranges and output aliasing", async () => {
  const bytes = await readFile(join(distributionRoot, "wasm/add-f32-scalar.wasm"));
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 1024 });
  const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
  const arenaBase = instance.exports.tabgrad_arena_base() >>> 0;

  assert.equal(instance.exports.tabgrad_add_f32(arenaBase + 2, arenaBase + 16, arenaBase + 32, 1), 1);
  assert.equal(
    instance.exports.tabgrad_add_f32(
      memory.buffer.byteLength - 4,
      arenaBase + 16,
      arenaBase + 32,
      2,
    ),
    2,
  );
  assert.equal(instance.exports.tabgrad_add_f32(arenaBase, arenaBase + 16, arenaBase, 1), 3);
});

test("the build keeps SIMD instructions out of the scalar module", async () => {
  const scalar = await readFile(join(distributionRoot, "wasm/add-f32-scalar.wasm"));
  const simd = await readFile(join(distributionRoot, "wasm/add-f32-simd128.wasm"));

  assert.equal(scalar.includes(0xfd), false);
  assert.equal(simd.includes(0xfd), true);
});

for (const failureCase of [
  {
    name: "incompatible ABI version",
    code: "BACKEND_ABI_MISMATCH",
    moduleOptions: { abiVersion: 2 },
  },
  {
    name: "missing kernel export",
    code: "BACKEND_ABI_MISMATCH",
    moduleOptions: { omitKernelExport: true },
  },
  {
    name: "unexpected module import",
    code: "BACKEND_ABI_MISMATCH",
    moduleOptions: { memoryImportName: "unexpected" },
  },
  {
    name: "invalid arena boundary",
    code: "BACKEND_ABI_MISMATCH",
    moduleOptions: { arenaBase: 1_048_577 },
  },
  {
    name: "missing capability",
    code: "BACKEND_CAPABILITY_MISMATCH",
    moduleOptions: { capabilities: 0 },
  },
  {
    name: "nonzero kernel status",
    code: "BACKEND_STATUS_ERROR",
    moduleOptions: { kernelBehavior: "status" },
  },
  {
    name: "kernel trap",
    code: "BACKEND_TRAP",
    moduleOptions: { kernelBehavior: "trap" },
  },
]) {
  test(`reports ${failureCase.name} as a structured failure`, async () => {
    const manifestUrl = installFixture(failureCase.name.replaceAll(" ", "-"), failureCase.moduleOptions);
    const session = createTestRuntimeSession({ manifestUrl, forceVariant: "scalar" });
    const left = session.tensor([1]);
    const right = session.tensor([2]);
    const result = left.add(right);
    await assert.rejects(
      result.toArray(),
      (error) => error instanceof TabgradError && error.code === failureCase.code,
    );
    assert.equal(session.diagnostics().liveRequestLeases, 0);
    assert.equal(session.diagnostics().liveAllocationBytes, 0);
    await session.close();
    assertNoLiveState(session);
  });
}

test("rejects malformed and hash-mismatched manifests", async () => {
  virtualResponses.set("/malformed.json", {
    body: Buffer.from("{}\n"),
    contentType: "application/json",
  });
  const malformed = createTestRuntimeSession({
    manifestUrl: new URL("malformed.json", distributionUrl),
    forceVariant: "scalar",
  });
  const malformedResult = malformed.tensor([1]).add(malformed.tensor([2]));
  await assert.rejects(
    malformedResult.toArray(),
    (error) => error instanceof TabgradError && error.code === "BACKEND_MANIFEST_INVALID",
  );
  await malformed.close();
  assertNoLiveState(malformed);

  const mismatchedUrl = installFixture("hash-mismatch", {}, (manifest) => ({
    ...manifest,
    variants: manifest.variants.map((variant) => ({ ...variant, sha256: "0".repeat(64) })),
  }));
  const mismatched = createTestRuntimeSession({
    manifestUrl: mismatchedUrl,
    forceVariant: "scalar",
  });
  const mismatchedResult = mismatched.tensor([1]).add(mismatched.tensor([2]));
  await assert.rejects(
    mismatchedResult.toArray(),
    (error) => error instanceof TabgradError && error.code === "BACKEND_HASH_MISMATCH",
  );
  await mismatched.close();
  assertNoLiveState(mismatched);
});

test("rejects ambiguous variants and non-relative artifact paths", async () => {
  for (const [name, transform] of [
    ["duplicate-variant", (manifest) => ({
      ...manifest,
      variants: manifest.variants.map((variant) => ({ ...variant, id: "scalar", requiredFeatures: [] })),
    })],
    ["absolute-artifact", (manifest) => ({
      ...manifest,
      variants: manifest.variants.map((variant) => variant.id === "scalar"
        ? { ...variant, path: "data:application/wasm;base64,AA==" }
        : variant),
    })],
  ]) {
    const manifestUrl = installFixture(name, {}, transform);
    const session = createTestRuntimeSession({ manifestUrl, forceVariant: "scalar" });
    const result = session.tensor([1]).add(session.tensor([2]));
    await assert.rejects(
      result.toArray(),
      (error) => error instanceof TabgradError
        && error.code === "BACKEND_MANIFEST_INVALID",
    );
    await session.close();
    assertNoLiveState(session);
  }
});

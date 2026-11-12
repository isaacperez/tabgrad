import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

test("worker diagnostics preserve the message when a browser stack omits it", async () => {
  const source = await readFile(new URL("../src/playground/executor.worker.js", import.meta.url), "utf8");
  const diagnostic = runInNewContext(source + "\ndescribe(input)", {
    addEventListener() {},
    input: { name: "TypeError", message: "the actionable error", stack: "calculate@worker.js:1:1" },
  });
  assert.match(diagnostic, /TypeError: the actionable error/);
  assert.match(diagnostic, /calculate@worker\.js:1:1/);
});


test("CPU observations use the public reader in both languages and preserve the pre-close sample", async () => {
  const source = await readFile(new URL("../src/playground/executor.worker.js", import.meta.url), "utf8");
  const messages = [];
  const initial = { webgpu: null, wasmMemoryBytes: 65536, highWaterAllocationBytes: 28,
    kernelCalls: 2, hostToWasmBytes: 12, hostToWasmCopies: 1, wasmToHostBytes: 4, wasmToHostCopies: 1 };
  for (const language of ["python", "javascript"]) {
    const inspect = runInNewContext(source + "\n(read, language, sample) => { sendToHost = message => messages.push(message); return runtimeResources(read, language, 'cpu', 12, sample); }", {
      addEventListener() {}, messages,
    });
    const sample = inspect(() => initial, language);
    assert.deepEqual(JSON.parse(JSON.stringify(sample)), { wasmMemoryBytes: 65536, peakAllocationBytes: 28, kernelCalls: 2,
      hostToWasmBytes: 12, hostToWasmCopies: 1, wasmToHostBytes: 4, wasmToHostCopies: 1 });
    assert.equal(messages.at(-1).data.language, language);
    assert.equal(messages.at(-1).data.gpu, null);
    const final = inspect(() => ({ ...initial, wasmMemoryBytes: 0, highWaterAllocationBytes: 0,
      kernelCalls: 3, wasmToHostBytes: 8, wasmToHostCopies: 2 }), language, sample);
    assert.equal(final.wasmMemoryBytes, 65536);
    assert.equal(final.peakAllocationBytes, 28);
    assert.equal(final.kernelCalls, 3, "cumulative counts include work completed during cleanup");
    assert.equal(final.wasmToHostBytes, 8);
    assert.equal(final.wasmToHostCopies, 2);
    const failure = new Error("reader cleanup failed");
    assert.throws(() => inspect(() => { throw failure; }, language), error => error === failure);
  }
});

for (const language of ["python", "javascript"]) test(`${language} retains unknown memory when the pre-close reading fails`, async () => {
  const source = await readFile(new URL("../src/playground/executor.worker.js", import.meta.url), "utf8");
  // Substitute module loading only; run the worker's actual execution and cleanup paths.
  const imports = [
    ["await import(assets.runtimeBase + 'index.js')", "runtimeApi"],
    ["await import(assets.runtimeBase + 'python.js')", "pythonApi"],
    ["await import(assets.pyodideBase + 'pyodide.mjs')", "interpreterApi"],
  ];
  let executable = source;
  for (const [expression, replacement] of imports) {
    assert.ok(executable.includes(expression));
    executable = executable.replace(expression, replacement);
  }
  const messages = [];
  let reads = 0, closed = false, ran = false, deleted = false;
  const owner = {
    allocate() { ran = true; },
    async runPythonAsync() { ran = true; },
    async close() { closed = true; },
    diagnostics() {
      if (++reads === 2) throw new Error("pre-close reader failed");
      return { webgpu: null, wasmMemoryBytes: closed ? 0 : 65536,
        highWaterAllocationBytes: !closed && ran ? 128 : 0, kernelCalls: ran ? 1 : 0,
        hostToWasmBytes: 8, hostToWasmCopies: 1, wasmToHostBytes: 4, wasmToHostCopies: 1 };
    },
  };
  await runInNewContext(executable + `\nsendToHost = message => messages.push(message);
    assets = { runtimeBase: '/runtime/', pyodideBase: '/python/' };
    start({ data: { language, device: 'cpu', source: 'session.allocate();' } });`, {
    addEventListener() {}, performance: { now: () => 1 }, messages, language,
    WebAssembly: { instantiate: WebAssembly.instantiate, instantiateStreaming: WebAssembly.instantiateStreaming },
    runtimeApi: { createRuntimeSession: () => owner }, pythonApi: { attachPython: async () => owner },
    interpreterApi: { loadPyodide: async () => ({ setStdout() {}, setStderr() {}, runPython() {}, globals: { set() {}, delete() { deleted = true; } } }) },
    TextDecoder,
  });
  assert.equal(closed, true);
  assert.equal(ran, true);
  assert.equal(reads, 3);
  assert.equal(deleted, language === "python");
  const final = messages.filter(message => message.kind === "resources").at(-1).data.cpu;
  assert.equal(final.wasmMemoryBytes, null, "closed capacity cannot stand in for a missing pre-close reading");
  assert.equal(final.peakAllocationBytes, null, "unknown peak is not measured zero");
  assert.equal(final.kernelCalls, 1);
  assert.equal(final.wasmToHostCopies, 1);
  assert.match(messages.at(-1).text, /pre-close reader failed/);
  assert.equal(messages.at(-1).kind, "failure");
  assert.equal(messages.some(message => message.kind === "done"), false);
});

test("console formatting preserves special numbers and ordinary JSON-style data", async () => {
  const source = await readFile(new URL("../src/playground/executor.worker.js", import.meta.url), "utf8");
  const cases = [
    ["NaN", "NaN"], ["Infinity", "Infinity"], ["-Infinity", "-Infinity"], ["-0", "-0"],
    ["[NaN, Infinity, -Infinity, -0, null, 1.5]", "[NaN,Infinity,-Infinity,-0,null,1.5]"],
    ['({number: NaN, text: "NaN", nested: {value: Infinity}, empty: null})', '{"number":NaN,"text":"NaN","nested":{"value":Infinity},"empty":null}'],
    ['({text: "<script>\\n", omitted: undefined, list: [undefined, true]})', '{"text":"<script>\\n","list":[null,true]}'],
    ["new Float32Array([NaN, Infinity, -0])", '{"0":NaN,"1":Infinity,"2":-0}'],
    ["new Number(-0)", "-0"], ["new String('text')", '"text"'], ["new Boolean(false)", "false"],
    ["Object(1n)", "1"], ["[1n, 2n]", "1,2"],
    ['new Date("2020-01-01T00:00:00Z")', '"2020-01-01T00:00:00.000Z"'],
    ['(() => { const f = function named() {}; f.toJSON = () => 2; return {f}; })()', '{"f":2}'],
    ["(() => { const value = {}; value.self = value; return value; })()", "[object Object]"],
    ["(() => { const a = {value: -0}; return {a, b:a}; })()", '{"a":{"value":-0},"b":{"value":-0}}'],
  ];
  for (const [expression, expected] of cases) {
    const actual = runInNewContext(source + `\ndisplay(${expression})`, { addEventListener() {} });
    assert.equal(actual, expected, expression);
  }
});

test("console formatting observes getters and toJSON once in serialization order", async () => {
  const source = await readFile(new URL("../src/playground/executor.worker.js", import.meta.url), "utf8");
  const calls = [];
  const result = runInNewContext(source + `\ndisplay({
    get first() { calls.push('first'); return NaN; },
    next: {toJSON(key) { calls.push(key); return Infinity; }}
  })`, { addEventListener() {}, calls });
  assert.equal(result, '{"first":NaN,"next":Infinity}');
  assert.deepEqual(calls, ["first", "next"]);
});

test("UTF-8 channel fragments retain text and do not consume a line per write", async () => {
  const source = await readFile(new URL("../src/playground/executor.worker.js", import.meta.url), "utf8");
  const messages = [];
  runInNewContext(source + `
    sendToHost = message => messages.push(message);
    const channel = new PythonOutput('stdout');
    const bytes = new TextEncoder().encode('\ufeffé🙂');
    for (const byte of bytes) channel.write(Uint8Array.of(byte));
    channel.finish();
    for (let i=0;i<1500;i++) writeOutput('stdout', 'x');
  `, {addEventListener() {}, TextEncoder, TextDecoder, messages});
  assert.equal(messages.map(message => message.text).join(""), "\ufeffé🙂" + "x".repeat(1500));
  assert.ok(messages.every(message => message.kind === "output"));
});

for (const [name, admitted, excess] of [
  ["characters", "x".repeat(64000), "x"],
  ["lines", "\n".repeat(999) + "last", "\nextra"],
]) test(`output ${name} budget remains shared across fragments`, async () => {
  const source = await readFile(new URL("../src/playground/executor.worker.js", import.meta.url), "utf8");
  const messages = [];
  runInNewContext(source + `
    sendToHost = message => messages.push(message);
    writeOutput('stdout', admitted);
    writeOutput('stderr', excess);
    writeOutput('stdout', 'ignored after the limit');
  `, {addEventListener() {}, messages, admitted, excess});
  assert.equal(messages[0].text, admitted);
  assert.equal(messages[0].kind, "output");
  assert.equal(messages[1].kind, "output-limit");
  assert.equal(messages.length, 2);
});

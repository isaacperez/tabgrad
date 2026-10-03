// Handcrafted raw-ABI modules for runtime preparation and failure tests.
// No production kernels or test cases are registered by importing this helper.

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

// A one-element arithmetic fixture that fails on exactly one selected call.
// The failure is a real Wasm status/exception, not a thrown JavaScript probe.
function scalarFaultKernel(behavior, failureCall, operation = "add") {
  return [
    0x23, 0x00, 0x41, 0x01, 0x6a, 0x24, 0x00, // ++global call counter
    0x23, 0x00, 0x41, ...signedLeb128(failureCall), 0x46,
    0x04, 0x40, // if counter == failureCall
    ...(behavior === "trap" ? [0x00] : [0x41, 0x07, 0x0f]),
    0x0b,
    0x20, operation === "sum" ? 0x01 : 0x02, // output address
    0x20, 0x00, 0x2a, 0x02, 0x00, // load left f32
    ...(operation === "sum" ? [] : [0x20, 0x01, 0x2a, 0x02, 0x00, operation === "mul" ? 0x94 : 0x92]),
    0x38, 0x02, 0x00, // store one-element result
    0x41, 0x00, 0x0b,
  ];
}

function functionType(parameters, results) {
  return [
    0x60,
    ...unsignedLeb128(parameters.length),
    ...parameters,
    ...unsignedLeb128(results.length),
    ...results,
  ];
}

function constantBody(value) {
  const instructions = [0x41, ...signedLeb128(value), 0x0b];
  const body = [0x00, ...instructions];
  return [...unsignedLeb128(body.length), ...body];
}

export function fixtureModule({
  abiVersion = 1,
  arenaBase = 1_048_576,
  capabilities = 15,
  kernelBehavior = "success",
  memoryImportName = "memory",
  omitKernelExport = false,
  omitSumExport = false,
  omitMulExport = false,
  omitExpandExport = false,
  failureCall,
} = {}) {
  const i32 = 0x7f;
  const types = section(1, [
    0x03,
    ...functionType([], [i32]),
    ...functionType([i32, i32, i32, i32], [i32]),
    ...functionType([i32, i32, i32], [i32]),
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
  const functions = section(3, [0x07, 0x00, 0x00, 0x00, 0x01, 0x02, 0x01, 0x02]);
  const exportedFunctions = [
    ["tabgrad_abi_version", 0],
    ["tabgrad_capabilities", 1],
    ["tabgrad_arena_base", 2],
    ...(omitKernelExport ? [] : [["tabgrad_add_f32", 3]]),
    ...(omitSumExport ? [] : [["tabgrad_sum_f32", 4]]),
    ...(omitMulExport ? [] : [["tabgrad_mul_f32", 5]]),
    ...(omitExpandExport ? [] : [["tabgrad_expand_f32", 6]]),
  ];
  const exports = section(7, [
    ...unsignedLeb128(exportedFunctions.length),
    ...exportedFunctions.flatMap(([name, index]) => [
      ...encodedString(name),
      0x00,
      ...unsignedLeb128(index),
    ]),
  ]);
  const kernelInstructions = failureCall !== undefined
    ? scalarFaultKernel(kernelBehavior, failureCall)
    : kernelBehavior === "trap"
    ? [0x00, 0x0b]
    : [0x41, ...signedLeb128(kernelBehavior === "status" ? 7 : 0), 0x0b];
  const kernelBody = [0x00, ...kernelInstructions];
  const sumBody = [0x00, ...(failureCall === undefined
    ? kernelInstructions : scalarFaultKernel(kernelBehavior, failureCall, "sum"))];
  const mulBody = [0x00, ...(failureCall === undefined
    ? kernelInstructions : scalarFaultKernel(kernelBehavior, failureCall, "mul"))];
  const code = section(10, [
    0x07,
    ...constantBody(abiVersion),
    ...constantBody(capabilities),
    ...constantBody(arenaBase),
    ...unsignedLeb128(kernelBody.length),
    ...kernelBody,
    ...unsignedLeb128(sumBody.length),
    ...sumBody,
    ...unsignedLeb128(mulBody.length),
    ...mulBody,
    ...unsignedLeb128(sumBody.length),
    ...sumBody,
  ]);
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...types,
    ...imports,
    ...functions,
    ...(failureCall === undefined ? [] : section(6, [0x01, i32, 0x01, 0x41, 0x00, 0x0b])),
    ...exports,
    ...code,
  ]);
}

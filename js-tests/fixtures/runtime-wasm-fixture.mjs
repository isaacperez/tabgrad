// Handcrafted raw-ABI modules for runtime preparation and failure tests.
// No production kernels or test cases are registered by importing this helper.

import { CPU_ABI_VERSION, CPU_CAPABILITY_MASK, CPU_REQUIRED_EXPORTS } from "../../dist/backends/cpu/kernel-catalogue.js";
import { CPU_MEMORY_PROFILE } from "../../dist/backends/cpu/memory-capacity.js";

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

// These fixture-specific operations only implement one float32 element.
const scalarFaultOperations = Object.freeze({
  tabgrad_sum_f32: "sum", tabgrad_expand_f32: "sum", tabgrad_receive_f32: "sum",
  tabgrad_mul_f32: "mul", tabgrad_mul_f16: "mul", tabgrad_add_alpha_f32: "mul",
  tabgrad_matmul_f32: "mul", tabgrad_broadcast_mul_f32: "mul", tabgrad_broadcast_mul_f16: "mul",
});

function kernelBody(name, behavior, failureCall, incompatibleAddResult) {
  const instructions = name === "tabgrad_add_f32" && incompatibleAddResult ? [0x42, 0x00, 0x0b]
    : failureCall !== undefined ? scalarFaultKernel(behavior, failureCall, scalarFaultOperations[name])
      : behavior === "trap" ? [0x00, 0x0b] : [0x41, ...signedLeb128(behavior === "status" ? 7 : 0), 0x0b];
  const body = [0x00, ...instructions];
  return [...unsignedLeb128(body.length), ...body];
}

export function fixtureModule({
  abiVersion = CPU_ABI_VERSION,
  arenaBase = 1_048_576,
  capabilities = CPU_CAPABILITY_MASK,
  kernelBehavior = "success",
  memoryImportName = "memory",
  omitExports = [],
  incompatibleAddParameter = false,
  incompatibleAddResult = false,
  failureCall,
} = {}) {
  const i32 = 0x7f;
  const exports = CPU_REQUIRED_EXPORTS.filter(([name]) => !omitExports.includes(name));
  const functionTypes = exports.map(([name, arity]) => {
    const parameters = new Array(arity).fill(i32);
    if (name === "tabgrad_add_f32" && incompatibleAddParameter) parameters[0] = 0x7d;
    return functionType(parameters, [name === "tabgrad_add_f32" && incompatibleAddResult ? 0x7e : i32]);
  });
  const bootstrap = { tabgrad_abi_version: abiVersion, tabgrad_capabilities: capabilities, tabgrad_arena_base: arenaBase };
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [...unsignedLeb128(functionTypes.length), ...functionTypes.flat()]),
    ...section(2, [
      0x01, ...encodedString("env"), ...encodedString(memoryImportName), 0x02, 0x01,
      ...unsignedLeb128(CPU_MEMORY_PROFILE.initialPages), ...unsignedLeb128(CPU_MEMORY_PROFILE.maximumPages),
    ]),
    ...section(3, [...unsignedLeb128(exports.length), ...exports.flatMap((_, index) => unsignedLeb128(index))]),
    ...(failureCall === undefined ? [] : section(6, [0x01, i32, 0x01, 0x41, 0x00, 0x0b])),
    ...section(7, [
      ...unsignedLeb128(exports.length),
      ...exports.flatMap(([name], index) => [...encodedString(name), 0x00, ...unsignedLeb128(index)]),
    ]),
    ...section(10, [
      ...unsignedLeb128(exports.length),
      ...exports.flatMap(([name]) => Object.hasOwn(bootstrap, name) ? constantBody(bootstrap[name])
        : kernelBody(name, kernelBehavior, failureCall, incompatibleAddResult)),
    ]),
  ]);
}

const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const minInt32 = -(2 ** 31);
const maxInt32 = 2 ** 31 - 1;
const minInt64 = -(2n ** 63n);
const maxInt64 = 2n ** 63n - 1n;

function exactInt32(value: unknown): number {
  if (typeof value === "bigint") {
    if (value >= BigInt(minInt32) && value <= BigInt(maxInt32)) return Number(value);
  } else if (typeof value === "number" && Number.isInteger(value) && value >= minInt32 && value <= maxInt32) {
    return value;
  }
  throw new TypeError("Int32 tensor data requires an exact signed 32-bit integer.");
}

function exactInt64(value: unknown): bigint {
  const integer = typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : value;
  if (typeof integer !== "bigint" || integer < minInt64 || integer > maxInt64) {
    throw new TypeError("Int64 tensor data requires a safe integer number or a signed 64-bit bigint.");
  }
  return integer;
}

export function captureInt32(data: Iterable<unknown> | ArrayLike<unknown>): Int32Array<ArrayBuffer> {
  const result = data instanceof Int32Array ? new Int32Array(data) : Int32Array.from(data as ArrayLike<number>, exactInt32);
  if (!littleEndian) {
    const bytes = new DataView(result.buffer);
    for (let index = 0; index < result.length; index++) bytes.setInt32(index * 4, result[index]!, true);
  }
  return result;
}

export function captureInt64(data: Iterable<unknown> | ArrayLike<unknown>): BigInt64Array<ArrayBuffer> {
  const result = data instanceof BigInt64Array ? new BigInt64Array(data) : BigInt64Array.from(data as ArrayLike<bigint>, exactInt64);
  if (!littleEndian) {
    const bytes = new DataView(result.buffer);
    for (let index = 0; index < result.length; index++) bytes.setBigInt64(index * 8, result[index]!, true);
  }
  return result;
}

export function observeInt32(bytes: Uint8Array<ArrayBuffer>, elements: number, copy: boolean): Int32Array<ArrayBuffer> {
  if (littleEndian) {
    const result = new Int32Array(bytes.buffer, bytes.byteOffset, elements);
    return copy ? result.slice() : result;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Int32Array(elements);
  for (let index = 0; index < elements; index++) result[index] = view.getInt32(index * 4, true);
  return result;
}

export function observeInt64(bytes: Uint8Array<ArrayBuffer>, elements: number, copy: boolean): BigInt64Array<ArrayBuffer> {
  if (littleEndian) {
    const result = new BigInt64Array(bytes.buffer, bytes.byteOffset, elements);
    return copy ? result.slice() : result;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new BigInt64Array(elements);
  for (let index = 0; index < elements; index++) result[index] = view.getBigInt64(index * 8, true);
  return result;
}

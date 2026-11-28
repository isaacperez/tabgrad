import { bfloat16ObservationBits, encodeBfloat16 } from "./bfloat16.js";
import { binary16ObservationBits, encodeBinary16 } from "./binary16.js";
import { TabgradError } from "./errors.js";

export type TensorData = Iterable<number | boolean> | ArrayLike<number | boolean>;
export type TensorObservation = Float32Array<ArrayBuffer> | Uint8Array<ArrayBuffer>;
export type ObservationFormat = "numeric" | "typed";
type EncodedStorage = Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer> | Uint8Array<ArrayBuffer>;

/** Pyodide borrow request and Python array format for original numeric input. */
const pythonInputs = Object.freeze({
  f32: Object.freeze({ request: "f32", typecode: "f", itemsize: 4, array: Float32Array } as const),
  f64: Object.freeze({ request: "f64", typecode: "d", itemsize: 8, array: Float64Array } as const),
  u8: Object.freeze({ request: "u8", typecode: "B", itemsize: 1, array: Uint8Array } as const),
});

export type PythonNumericInput = typeof pythonInputs[keyof typeof pythonInputs];

const realFloatingPoint = Object.freeze({ is_floating_point: true, is_complex: false, is_signed: true });

interface DTypeDefinition {
  readonly name: string;
  readonly encoding: string;
  readonly bytesPerElement: number;
  readonly capture: (data: TensorData) => EncodedStorage;
  readonly observe: (bytes: Uint8Array<ArrayBuffer>, elements: number, copy: boolean) => Float32Array<ArrayBuffer>;
  readonly observeTyped?: (bytes: Uint8Array<ArrayBuffer>, elements: number, copy: boolean) => TensorObservation;
  readonly pythonInput: PythonNumericInput;
  readonly properties: Readonly<{ is_floating_point: boolean; is_complex: boolean; is_signed: boolean }>;
}

export function invalidTensorData(cause?: unknown): TabgradError {
  return new TabgradError(
    "INVALID_DATA",
    "Tensor data must be a finite iterable or array-like collection of numbers.",
    { operation: "tensor", contract: "numeric-data" },
    cause,
  );
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number") throw invalidTensorData();
  return value;
}

function requireBinary16(value: unknown): number {
  return encodeBinary16(requireNumber(value));
}

function encodeBoolean(value: unknown): number {
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number") return Number(value !== 0);
  throw invalidTensorData();
}

function observeFloat32(bytes: Uint8Array<ArrayBuffer>, elements: number, copy: boolean): Float32Array<ArrayBuffer> {
  const numeric = new Float32Array(bytes.buffer, bytes.byteOffset, elements);
  return copy ? numeric.slice() : numeric;
}

function observeBinary16(bytes: Uint8Array<ArrayBuffer>, elements: number): Float32Array<ArrayBuffer> {
  const words = new Uint16Array(bytes.buffer, bytes.byteOffset, elements);
  const numeric = new Float32Array(elements);
  const observed = new Uint32Array(numeric.buffer);
  // Process two words per iteration to reduce loop overhead on large readbacks.
  let index = 0;
  for (; index + 1 < elements; index += 2) {
    observed[index] = binary16ObservationBits(words[index]!);
    observed[index + 1] = binary16ObservationBits(words[index + 1]!);
  }
  if (index < elements) observed[index] = binary16ObservationBits(words[index]!);
  return numeric;
}

function observeBfloat16(bytes: Uint8Array<ArrayBuffer>, elements: number): Float32Array<ArrayBuffer> {
  const words = new Uint16Array(bytes.buffer, bytes.byteOffset, elements);
  const numeric = new Float32Array(elements);
  const observed = new Uint32Array(numeric.buffer);
  for (let index = 0; index < elements; index++) observed[index] = bfloat16ObservationBits(words[index]!);
  return numeric;
}

/** Logical tensor formats; protocol words and backend scratch storage are separate. */
export const TENSOR_DTYPES = Object.freeze({
  float32: Object.freeze({
    name: "float32", encoding: "ieee754-binary32-native", bytesPerElement: 4,
    // Both overloads call the same builtin, which selects the iterator first.
    capture: (data: TensorData) => Float32Array.from(data as ArrayLike<number>, requireNumber),
    observe: observeFloat32, pythonInput: pythonInputs.f32, properties: realFloatingPoint,
  } as const),
  float16: Object.freeze({
    name: "float16", encoding: "ieee754-binary16-native", bytesPerElement: 2,
    capture: (data: TensorData) => Uint16Array.from(data as ArrayLike<number>, requireBinary16),
    observe: observeBinary16, pythonInput: pythonInputs.f64, properties: realFloatingPoint,
  } as const),
  bfloat16: Object.freeze({
    name: "bfloat16", encoding: "ieee754-bfloat16-native", bytesPerElement: 2,
    capture: (data: TensorData) => Uint16Array.from(data as ArrayLike<number>, value => encodeBfloat16(requireNumber(value))),
    observe: observeBfloat16, pythonInput: pythonInputs.f32, properties: realFloatingPoint,
  } as const),
  bool: Object.freeze({
    name: "bool", encoding: "bool-u8", bytesPerElement: 1,
    capture: (data: TensorData) => Uint8Array.from(data as ArrayLike<number>, encodeBoolean),
    observe: (bytes: Uint8Array<ArrayBuffer>) => Float32Array.from(bytes),
    observeTyped: (bytes: Uint8Array<ArrayBuffer>, _elements: number, copy: boolean) => copy ? bytes.slice() : bytes,
    pythonInput: pythonInputs.u8, properties: Object.freeze({ is_floating_point: false, is_complex: false, is_signed: false }),
  } as const),
} satisfies Readonly<Record<string, DTypeDefinition>>);

export type TensorDType = keyof typeof TENSOR_DTYPES;
export type TensorDTypeDescriptor = typeof TENSOR_DTYPES[TensorDType];
export type TensorEncoding = TensorDTypeDescriptor["encoding"];

/** Encodings supported by the current byte-oriented CPU and GPU storage. */
export const TENSOR_STORAGE_ENCODINGS = Object.freeze([...new Set(
  Object.values(TENSOR_DTYPES).map(descriptor => descriptor.encoding),
)]);

export function isTensorDType(dtype: unknown): dtype is TensorDType {
  return typeof dtype === "string" && Object.hasOwn(TENSOR_DTYPES, dtype);
}

export function tensorDType(dtype: TensorDType): TensorDTypeDescriptor {
  if (!isTensorDType(dtype)) throw new TypeError("Unsupported tensor dtype.");
  return TENSOR_DTYPES[dtype];
}

/** Checked arithmetic without allocating an intermediate span descriptor. */
export function checkedElementBytes(elements: number, bytesPerElement: number): number {
  if (!Number.isSafeInteger(elements) || elements < 0
    || !Number.isSafeInteger(bytesPerElement) || bytesPerElement <= 0) {
    throw new TypeError("Tensor spans require a nonnegative element count and a positive element width.");
  }
  const bytes = elements * bytesPerElement;
  if (!Number.isSafeInteger(bytes)) throw new RangeError("Tensor byte extent exceeds safe arithmetic.");
  return bytes;
}

/** Physical alignment is selected by the storage owner, not by the logical dtype. */
export function alignedByteLength(logicalBytes: number, alignment: number): number {
  if (!Number.isSafeInteger(logicalBytes) || logicalBytes < 0
    || !Number.isSafeInteger(alignment) || alignment <= 0) {
    throw new TypeError("Storage spans require a nonnegative byte extent and a positive alignment.");
  }
  const padding = (alignment - logicalBytes % alignment) % alignment;
  const bytes = logicalBytes + padding;
  if (!Number.isSafeInteger(bytes)) throw new RangeError("Aligned storage extent exceeds safe arithmetic.");
  return bytes;
}

export function tensorByteLength(dtype: TensorDType, elements: number): number {
  return checkedElementBytes(elements, tensorDType(dtype).bytesPerElement);
}

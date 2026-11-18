/** Logical tensor formats; protocol words and backend scratch storage are separate. */
export const TENSOR_DTYPES = Object.freeze({
  float32: Object.freeze({ name: "float32", encoding: "ieee754-binary32-native", bytesPerElement: 4 } as const),
  float16: Object.freeze({ name: "float16", encoding: "ieee754-binary16-native", bytesPerElement: 2 } as const),
});

export type TensorDType = keyof typeof TENSOR_DTYPES;

export function tensorDType(dtype: TensorDType): typeof TENSOR_DTYPES[TensorDType] {
  if (!Object.hasOwn(TENSOR_DTYPES, dtype)) throw new TypeError("Unsupported tensor dtype.");
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

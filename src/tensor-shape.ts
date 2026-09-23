import { TabgradError } from "./errors.js";

function invalidShape(dataLength: number, cause?: unknown): TabgradError {
  return new TabgradError(
    "INVALID_SHAPE",
    "Tensor dimensions must be non-negative safe integers whose product matches the data length.",
    { operation: "tensor", contract: "contiguous-shape", dataLength },
    cause,
  );
}

/** Count elements of an admitted shape; scalar rank has the empty product one. */
export function tensorElementCount(shape: readonly number[]): number {
  // A zero anywhere makes the tensor empty, even after a very large prefix.
  if (shape.includes(0)) return 0;
  return shape.reduce((count, dimension) => count * dimension, 1);
}

/** Own and validate shape once at admission, independently of a backend address. */
export function copyTensorShape(shape: unknown, dataLength: number): readonly number[] {
  try {
    if (shape === undefined) return Object.freeze([dataLength]);
    if (!Array.isArray(shape)) throw invalidShape(dataLength);
    const dimensions: number[] = [];
    for (const dimension of shape as readonly unknown[]) {
      if (typeof dimension !== "number" || !Number.isSafeInteger(dimension) || dimension < 0) {
        throw invalidShape(dataLength);
      }
      dimensions.push(dimension);
    }
    const count = tensorElementCount(dimensions);
    if (!Number.isSafeInteger(count) || count !== dataLength) throw invalidShape(dataLength);
    return Object.freeze(dimensions);
  } catch (error) {
    if (error instanceof TabgradError) throw error;
    throw invalidShape(dataLength, error);
  }
}

/** Shape equality is stronger than equal element count, including for empty values. */
export function equalTensorShapes(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((dimension, index) => dimension === right[index]);
}

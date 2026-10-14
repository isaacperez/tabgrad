/** Immutable ordinary matrix orientation: bit 0 transposes left, bit 1 right. */
export function assertMatrixFlags(kind: string, flags: number | undefined): void {
  if (kind === "matmul-f32") {
    if (!Number.isInteger(flags) || flags! < 0 || flags! > 3) {
      throw new TypeError("Matrix multiplication requires captured orientation flags.");
    }
  } else if (flags !== undefined) {
    throw new TypeError("This operation has no matrix orientation.");
  }
}

export interface MatrixGeometry {
  readonly rows: number;
  readonly contraction: number;
  readonly columns: number;
  readonly outputElements: number;
}

function assertMatrixShape(shape: readonly number[]): void {
  if (shape.length !== 2 || shape.some(dimension => !Number.isSafeInteger(dimension) || dimension < 0)) {
    throw new TypeError("Matrix multiplication requires two-dimensional nonnegative safe shapes.");
  }
  if (shape[0] !== 0 && shape[1] !== 0 && !Number.isSafeInteger(shape[0]! * shape[1]!)) {
    throw new TypeError("Matrix element count exceeds safe integer arithmetic.");
  }
}

/** Derive logical geometry from captured shapes, including unused large empty axes. */
export function matrixGeometry(left: readonly number[], right: readonly number[], flags: number): MatrixGeometry {
  assertMatrixFlags("matmul-f32", flags);
  assertMatrixShape(left);
  assertMatrixShape(right);
  const rows = left[flags & 1 ? 1 : 0]!;
  const contraction = left[flags & 1 ? 0 : 1]!;
  const rightContraction = right[flags & 2 ? 1 : 0]!;
  const columns = right[flags & 2 ? 0 : 1]!;
  if (contraction !== rightContraction) throw new TypeError("Matrix contraction dimensions must match.");
  const outputElements = rows === 0 || columns === 0 ? 0 : rows * columns;
  // Public admission reports capacity exhaustion; reconstructed programs reject
  // unsafe output metadata. Those callers own the distinct error contracts.
  return { rows, contraction, columns, outputElements };
}

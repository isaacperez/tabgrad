/** Immutable ordinary matrix orientation: bit 0 transposes left, bit 1 right. */
export function assertMatrixOrientation(flags: number | undefined): void {
  if (!Number.isInteger(flags) || flags! < 0 || flags! > 3) {
    throw new TypeError("Matrix multiplication requires captured orientation flags.");
  }
}

export interface MatrixGeometry {
  readonly rows: number;
  readonly contraction: number;
  readonly columns: number;
  readonly outputElements: number;
}

export class MatrixShapeError extends TypeError {
  constructor(readonly reason: "rank" | "contraction", message: string) { super(message); }
}

function assertMatrixShape(shape: readonly number[]): void {
  if (shape.some(dimension => !Number.isSafeInteger(dimension) || dimension < 0)) {
    throw new TypeError("Matrix multiplication requires two-dimensional nonnegative safe shapes.");
  }
  if (shape[0] !== 0 && shape[1] !== 0 && !Number.isSafeInteger(shape[0]! * shape[1]!)) {
    throw new TypeError("Matrix element count exceeds safe integer arithmetic.");
  }
}

/** Derive logical geometry from captured shapes, including unused large empty axes. */
export function matrixGeometry(left: readonly number[], right: readonly number[], flags: number): MatrixGeometry {
  assertMatrixOrientation(flags);
  if (left.length !== 2 || right.length !== 2) {
    throw new MatrixShapeError("rank", "Matrix multiplication requires two-dimensional nonnegative safe shapes.");
  }
  assertMatrixShape(left);
  assertMatrixShape(right);
  const rows = left[flags & 1 ? 1 : 0]!;
  const contraction = left[flags & 1 ? 0 : 1]!;
  const rightContraction = right[flags & 2 ? 1 : 0]!;
  const columns = right[flags & 2 ? 0 : 1]!;
  if (contraction !== rightContraction) throw new MatrixShapeError("contraction", "Matrix contraction dimensions must match.");
  const outputElements = rows === 0 || columns === 0 ? 0 : rows * columns;
  // Public admission reports capacity exhaustion; reconstructed programs reject
  // unsafe output metadata. Those callers own the distinct error contracts.
  return { rows, contraction, columns, outputElements };
}

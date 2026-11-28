import { TabgradError } from "../shared/errors.js";

export interface AxisReduction {
  readonly axis: number | null;
  readonly keepDim: boolean;
}

export interface AxisReductionGeometry {
  readonly shape: readonly number[];
  readonly groups: number;
  readonly terms: number;
  readonly inner: number;
}

export function normalizeAxis(axis: number, rank: number): number {
  if (!Number.isInteger(axis)) throw new TypeError("Dimension must be an integer.");
  const extent = Math.max(1, rank);
  if (axis < -extent || axis >= extent) {
    throw new TabgradError("INVALID_SHAPE", "Dimension is out of range.", { axis, rank });
  }
  return axis < 0 ? extent + axis : axis;
}

function elements(shape: readonly number[]): number {
  // Empty logical shapes need not fit into a physical address space.
  if (shape.includes(0)) return 0;
  const count = shape.reduce((product, dimension) => product * dimension, 1);
  if (!Number.isSafeInteger(count)) throw new TabgradError("RESOURCE_EXHAUSTED", "Axis geometry exceeds safe element arithmetic.");
  return count;
}

export function axisReductionGeometry(shape: readonly number[], reduction: AxisReduction): AxisReductionGeometry {
  const { axis, keepDim } = reduction;
  const terms = axis === null ? elements(shape) : shape[axis] ?? (shape.length === 0 && axis === 0 ? 1 : 0);
  if (terms === 0) throw new TabgradError("INVALID_SHAPE", "Argmax requires a nonempty reduction axis.");
  if (axis === null) return { shape: keepDim ? shape.map(() => 1) : [], groups: 1, terms, inner: 1 };
  const output = keepDim ? shape.map((dimension, position) => axis === position ? 1 : dimension)
    : shape.filter((_dimension, position) => position !== axis);
  const groups = elements(output);
  return { shape: output, groups, terms, inner: groups === 0 ? 0 : elements(shape.slice(axis + 1)) };
}

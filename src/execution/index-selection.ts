import { TabgradError } from "../shared/errors.js";

const WORD = 2 ** 32;

export interface IndexSelectionGeometry {
  readonly shape: readonly number[];
  readonly count: number;
  readonly inner: number;
  readonly outputElements: number;
  readonly boundLow: number;
  readonly boundHigh: number;
}

function physicalElements(shape: readonly number[]): number {
  if (shape.includes(0)) return 0;
  const elements = shape.reduce((size, dimension) => size * dimension, 1);
  if (!Number.isSafeInteger(elements)) {
    throw new TabgradError("RESOURCE_EXHAUSTED", "Index selection exceeds safe shape arithmetic.");
  }
  return elements;
}

/** Both frontends receive the native exception category from the causal operation. */
export function indexSelectionBoundsError(source: readonly number[], axis: number,
  details: Readonly<Record<string, unknown>> = {}, position?: number): TabgradError {
  const reason = source.length > 1 && (axis === 1 || source.includes(0)) ? "runtime" : "index";
  const message = position === undefined ? "Index out of bounds in index_select."
    : `Index at position ${position} is out of bounds in index_select.`;
  return new TabgradError("INDEX_OUT_OF_BOUNDS", message, { ...details, reason });
}

/** Logical bounds remain wide even when the physical input and output are empty. */
export function indexSelectionGeometry(source: readonly number[], indices: readonly number[], axis: number): IndexSelectionGeometry {
  if (indices.length > 1) {
    throw new TabgradError("INVALID_SHAPE", "index_select requires a scalar or one-dimensional index.");
  }
  const count = indices[0] ?? 1;
  if (source.length === 0 && count !== 1) {
    throw new TabgradError("INVALID_SHAPE", "index_select on a scalar requires exactly one index.");
  }
  const bound = source[axis] ?? 1;
  if (bound === 0 && count !== 0) throw indexSelectionBoundsError(source, axis);
  const shape = source.map((size, dimension) => dimension === axis ? count : size);
  const outputElements = physicalElements(shape);
  return { shape, count, outputElements, inner: outputElements === 0 ? 0 : physicalElements(source.slice(axis + 1)),
    boundLow: bound % WORD, boundHigh: Math.floor(bound / WORD) };
}

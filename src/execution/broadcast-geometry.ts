/** A family maps its selected input domain into an ordered common domain. */
export interface BroadcastDomain {
  readonly shape: readonly number[];
  readonly axes: readonly number[];
}

export interface BroadcastOperand extends BroadcastDomain {
  readonly alignedShape: readonly number[];
  readonly strides: readonly number[];
  readonly elements: number;
}

export interface BroadcastGeometry {
  readonly shape: readonly number[];
  readonly elements: number;
  readonly operands: readonly BroadcastOperand[];
  readonly execution: Readonly<{
    dimensions: readonly number[];
    strides: readonly (readonly number[])[];
  }>;
}

export interface ReceivingGeometry {
  readonly originalShape: readonly number[];
  /** A fresh reduction keeps introduced axes; restoration removes them by view. */
  readonly shape: readonly number[];
  readonly exact: boolean;
  readonly groups: number;
  readonly terms: number;
  readonly groupDimensions: readonly number[];
  readonly groupStrides: readonly number[];
  readonly termDimensions: readonly number[];
  readonly termStrides: readonly number[];
}

/** Admission distinguishes capacity from incompatible dimensions without text matching. */
export class BroadcastCapacityError extends TypeError {}

/** Zero-aware counts never evaluate an unused overflowing stride product. */
export function domainElements(shape: readonly number[]): number {
  if (shape.some(dimension => !Number.isSafeInteger(dimension) || dimension < 0)) {
    throw new TypeError("A broadcast domain requires nonnegative safe dimensions.");
  }
  const count = shape.includes(0) ? 0 : shape.reduce((size, dimension) => size * dimension, 1);
  if (!Number.isSafeInteger(count)) throw new BroadcastCapacityError("Broadcast element count exceeds safe integer arithmetic.");
  return count;
}

function contiguousStrides(shape: readonly number[], elements: number): number[] {
  const strides = new Array<number>(shape.length).fill(0);
  if (elements === 0) return strides;
  let stride = 1;
  for (let axis = shape.length - 1; axis >= 0; axis--) {
    strides[axis] = stride;
    stride *= shape[axis]!;
  }
  return strides;
}

function coalesceAxes(shape: readonly number[], projections: readonly (readonly number[])[]): BroadcastGeometry["execution"] {
  const dimensions: number[] = [];
  const strides: number[][] = projections.map(() => []);
  for (let axis = 0; axis < shape.length; axis++) {
    const dimension = shape[axis]!;
    if (dimension === 1) continue;
    const previous = dimensions.length - 1;
    if (previous >= 0 && projections.every((projection, index) => strides[index]![previous] === projection[axis]! * dimension)) {
      dimensions[previous]! *= dimension;
      projections.forEach((projection, index) => { strides[index]![previous] = projection[axis]!; });
    } else {
      dimensions.push(dimension);
      projections.forEach((projection, index) => strides[index]!.push(projection[axis]!));
    }
  }
  return Object.freeze({ dimensions: Object.freeze(dimensions), strides: Object.freeze(strides.map(value => Object.freeze(value))) });
}

/** Pure compatibility, projections and coalescing; no operation or device state. */
export function broadcastGeometry(rank: number, domains: readonly BroadcastDomain[]): BroadcastGeometry {
  if (!Number.isSafeInteger(rank) || rank < 0 || domains.length === 0) throw new TypeError("A broadcast request requires a rank and operands.");
  const shape = new Array<number>(rank).fill(1);
  const captured = domains.map(domain => {
    const original = Object.freeze([...domain.shape]);
    const axes = Object.freeze([...domain.axes]);
    const elements = domainElements(original);
    if (axes.length !== original.length || axes.some((axis, index) => !Number.isSafeInteger(axis)
      || axis < 0 || axis >= rank || (index !== 0 && axis <= axes[index - 1]!))) {
      throw new TypeError("Broadcast axes must preserve original input order within the domain.");
    }
    const alignedShape = new Array<number>(rank).fill(1);
    for (let index = 0; index < original.length; index++) {
      const axis = axes[index]!, dimension = original[index]!;
      alignedShape[axis] = dimension;
      if (shape[axis] === 1) shape[axis] = dimension;
      else if (dimension !== 1 && dimension !== shape[axis]) throw new TypeError("Broadcast dimensions must be equal or singleton.");
    }
    return { shape: original, axes, alignedShape: Object.freeze(alignedShape), elements };
  });
  const elements = domainElements(shape);
  const operands = Object.freeze(captured.map(operand => {
    const originalStrides = contiguousStrides(operand.shape, operand.elements);
    const strides = new Array<number>(rank).fill(0);
    if (elements !== 0) operand.axes.forEach((axis, index) => {
      if (operand.shape[index] !== 1) strides[axis] = originalStrides[index]!;
    });
    return Object.freeze({ ...operand, strides: Object.freeze(strides) });
  }));
  return Object.freeze({ shape: Object.freeze(shape), elements, operands,
    execution: coalesceAxes(elements === 0 ? [] : shape, operands.map(operand => operand.strides)) });
}

/** The pointwise family selects all dimensions with ordinary trailing alignment. */
export function pointwiseGeometry(shapes: readonly (readonly number[])[]): BroadcastGeometry {
  const rank = shapes.reduce((maximum, shape) => Math.max(maximum, shape.length), 0);
  return broadcastGeometry(rank, shapes.map(shape => ({ shape, axes: shape.map((_dimension, axis) => rank - shape.length + axis) })));
}

/** Invert the actual projection; each source contribution belongs to one group. */
export function receivingGeometry(geometry: BroadcastGeometry, position: number): ReceivingGeometry {
  const operand = geometry.operands[position];
  if (operand === undefined) throw new TypeError("A receiving projection requires an operand position.");
  const groups = operand.elements;
  const terms = groups === 0 ? 0 : geometry.elements / groups;
  const sourceStrides = contiguousStrides(geometry.shape, geometry.elements);
  const groupDimensions: number[] = [], groupStrides: number[] = [], termDimensions: number[] = [], termStrides: number[] = [];
  if (groups !== 0 && terms !== 0) for (let axis = 0; axis < geometry.shape.length; axis++) {
    if (geometry.shape[axis] === 1) continue;
    const reduced = operand.alignedShape[axis] === 1;
    (reduced ? termDimensions : groupDimensions).push(geometry.shape[axis]!);
    (reduced ? termStrides : groupStrides).push(sourceStrides[axis]!);
  }
  const groupAxes = coalesceAxes(groupDimensions, [groupStrides]);
  const termAxes = coalesceAxes(termDimensions, [termStrides]);
  return Object.freeze({ originalShape: operand.shape, shape: operand.alignedShape,
    exact: operand.shape.length === geometry.shape.length && operand.shape.every((dimension, axis) => dimension === geometry.shape[axis]),
    groups, terms, groupDimensions: groupAxes.dimensions, groupStrides: groupAxes.strides[0]!,
    termDimensions: termAxes.dimensions, termStrides: termAxes.strides[0]! });
}

import type { BroadcastGeometry, ReceivingGeometry } from "../../execution/broadcast-geometry.js";
import { TabgradError } from "../../shared/errors.js";

function packet(words: number, maximumBytes: number): Uint32Array {
  if (!Number.isSafeInteger(words) || words < 0 || words > Math.min(0xffff_ffff, maximumBytes) / 4) {
    throw new TabgradError("RESOURCE_EXHAUSTED", "Broadcast parameters exceed the CPU address domain.");
  }
  return new Uint32Array(words);
}

function assertWords(values: readonly number[]): void {
  if (values.some(value => !Number.isInteger(value) || value < 0 || value > 0xffff_ffff)) {
    throw new TabgradError("RESOURCE_EXHAUSTED", "Broadcast indices exceed the CPU address domain.");
  }
}

/** Mutable private counters follow immutable geometry; never retained in history. */
export function pointwisePacket(geometry: BroadcastGeometry, maximumBytes: number): Uint32Array {
  const { dimensions, strides } = geometry.execution, arity = geometry.operands.length;
  assertWords([geometry.elements, ...geometry.operands.map(value => value.elements), ...dimensions]);
  for (const operand of strides) assertWords(operand);
  const result = packet(3 + arity + dimensions.length * (arity + 2), maximumBytes);
  result.set([dimensions.length, arity, geometry.elements, ...geometry.operands.map(value => value.elements)]);
  dimensions.forEach((dimension, axis) => {
    result[3 + arity + axis * (arity + 1)] = dimension;
    for (let operand = 0; operand < arity; operand++) result[4 + arity + axis * (arity + 1) + operand] = strides[operand]![axis]!;
  });
  return result;
}

export function receivingPacket(projection: ReceivingGeometry, maximumBytes: number): Uint32Array {
  const count = projection.groups * projection.terms;
  // No physical coordinates are consumed for an empty source, even when its
  // logical axes exceed u32 or their unused products exceed safe arithmetic.
  const groupRank = count === 0 ? 0 : projection.groupDimensions.length;
  const termRank = count === 0 ? 0 : projection.termDimensions.length;
  assertWords([count, projection.groups, projection.terms]);
  if (count !== 0) for (const values of [projection.groupDimensions, projection.groupStrides, projection.termDimensions, projection.termStrides]) assertWords(values);
  const result = packet(5 + 2 * (groupRank + termRank), maximumBytes);
  result.set([count, projection.groups, projection.terms, groupRank, termRank]);
  for (let axis = 0; axis < groupRank; axis++) result.set([projection.groupDimensions[axis]!, projection.groupStrides[axis]!], 5 + axis * 2);
  for (let axis = 0; axis < termRank; axis++) result.set([projection.termDimensions[axis]!, projection.termStrides[axis]!], 5 + 2 * (groupRank + axis));
  return result;
}

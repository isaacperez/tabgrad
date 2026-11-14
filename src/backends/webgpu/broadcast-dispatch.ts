import type { BroadcastGeometry, ReceivingGeometry } from "../../execution/broadcast-geometry.js";
import { TabgradError } from "../../shared/errors.js";
import { WEBGPU_SUM_GROUP_ELEMENTS, WEBGPU_SUM_PARTIAL_BYTES } from "./kernels/sum.js";

export interface BroadcastDispatchLimits {
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxComputeWorkgroupsPerDimension: number;
}

function storageBytes(bytes: number, limits: BroadcastDispatchLimits): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || Math.max(4, bytes) > Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize, 0xffff_ffff)) {
    throw new TabgradError("RESOURCE_EXHAUSTED", "Broadcast storage exceeds the selected GPU limits.");
  }
}

function word(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new TabgradError("RESOURCE_EXHAUSTED", "Broadcast GPU indices exceed u32.");
  return value;
}

export function pointwiseParameters(geometry: BroadcastGeometry, limits: BroadcastDispatchLimits): Uint32Array {
  const { dimensions, strides } = geometry.execution;
  storageBytes((3 + dimensions.length * 3) * 4, limits);
  const inner = dimensions.at(-1) ?? 1;
  const width = inner % 4 === 0 && strides.every(operand => (operand.at(-1) ?? 0) <= 1) ? 4 : 1;
  const result = new Uint32Array(3 + dimensions.length * 3);
  result.set([dimensions.length, word(geometry.elements), width]);
  dimensions.forEach((dimension, axis) => result.set([word(dimension), word(strides[0]![axis]!), word(strides[1]![axis]!)], 3 + axis * 3));
  return result;
}

export function receivingParameters(projection: ReceivingGeometry, limits: BroadcastDispatchLimits): Uint32Array {
  const nonempty = projection.terms !== 0;
  const groupRank = nonempty ? projection.groupDimensions.length : 0;
  const termRank = nonempty ? projection.termDimensions.length : 0;
  storageBytes((2 + 2 * (groupRank + termRank)) * 4, limits);
  const result = new Uint32Array(2 + 2 * (groupRank + termRank));
  result.set([groupRank, termRank]);
  for (let axis = 0; axis < groupRank; axis++) result.set([word(projection.groupDimensions[axis]!), word(projection.groupStrides[axis]!)], 2 + axis * 2);
  for (let axis = 0; axis < termRank; axis++) result.set([word(projection.termDimensions[axis]!), word(projection.termStrides[axis]!)], 2 + 2 * (groupRank + axis));
  return result;
}

export interface ReceivingStage {
  readonly count: number;
  readonly chunks: number;
  readonly workgroups: number;
  readonly bytes: number;
  readonly partial: boolean;
  readonly final: boolean;
}

/** Bound every intermediate before enqueuing writes; windows are streamed later. */
export function receivingStages(projection: ReceivingGeometry, limits: BroadcastDispatchLimits): readonly ReceivingStage[] {
  word(projection.groups); word(projection.terms); word(projection.groups * projection.terms);
  if (!Number.isSafeInteger(limits.maxComputeWorkgroupsPerDimension) || limits.maxComputeWorkgroupsPerDimension < 1) {
    throw new TabgradError("RESOURCE_EXHAUSTED", "Receiving reduction requires a GPU workgroup window.");
  }
  const stages: ReceivingStage[] = [];
  let count = projection.terms, partial = false;
  do {
    const chunks = Math.max(1, Math.ceil(count / WEBGPU_SUM_GROUP_ELEMENTS));
    const workgroups = word(projection.groups * chunks);
    const final = chunks === 1;
    const bytes = workgroups * (final ? 4 : WEBGPU_SUM_PARTIAL_BYTES);
    storageBytes(bytes, limits);
    stages.push(Object.freeze({ count, chunks, workgroups, bytes, partial, final }));
    count = chunks; partial = true;
    if (final) break;
  } while (true);
  return Object.freeze(stages);
}

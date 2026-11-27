import { TabgradError } from "../../shared/errors.js";
import { gpuStorageCapacityBytes } from "./webgpu-capacity.js";

export interface ReductionStage {
  readonly count: number;
  readonly chunks: number;
  readonly workgroups: number;
  readonly bytes: number;
  readonly partial: boolean;
  readonly final: boolean;
}

/** Receiver projection and dispatch are independent of the partial representation. */
export function reductionStages(count: number, groups: number,
  elementsPerGroup: number, partialBytes: number,
  limits: { readonly maxBufferSize: number; readonly maxStorageBufferBindingSize: number }): readonly ReductionStage[] {
  const stages: ReductionStage[] = [];
  let partial = false;
  do {
    const chunks = Math.max(1, Math.ceil(count / elementsPerGroup));
    const workgroups = groups * chunks;
    const final = chunks === 1;
    // Both scalar storage formats occupy one physical GPU word.
    const bytes = workgroups * (final ? 4 : partialBytes);
    if (!Number.isSafeInteger(count) || count < 0 || count > 0xffff_ffff
      || !Number.isSafeInteger(workgroups) || workgroups < 0 || workgroups > 0xffff_ffff
      || !Number.isSafeInteger(bytes) || Math.max(4, bytes) > gpuStorageCapacityBytes(limits)) {
      throw new TabgradError("RESOURCE_EXHAUSTED", "GPU reduction partials exceed their storage or index domain.");
    }
    stages.push(Object.freeze({ count, chunks, workgroups, bytes, partial, final }));
    count = chunks; partial = true;
    if (final) break;
  } while (true);
  return Object.freeze(stages);
}

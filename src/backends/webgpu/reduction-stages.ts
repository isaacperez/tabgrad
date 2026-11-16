import { TabgradError } from "../../shared/errors.js";
import { gpuStorageCapacityBytes } from "./webgpu-capacity.js";
import { WEBGPU_SUM_GROUP_ELEMENTS, WEBGPU_SUM_PARTIAL_BYTES } from "./kernels/sum.js";

export interface ReductionStage {
  readonly count: number;
  readonly chunks: number;
  readonly workgroups: number;
  readonly bytes: number;
  readonly partial: boolean;
  readonly final: boolean;
}

/** Exact-sum partial layout is shared; receiver projection and launch stay separate. */
export function reductionStages(count: number, groups: number,
  limits: { readonly maxBufferSize: number; readonly maxStorageBufferBindingSize: number }): readonly ReductionStage[] {
  const stages: ReductionStage[] = [];
  let partial = false;
  do {
    const chunks = Math.max(1, Math.ceil(count / WEBGPU_SUM_GROUP_ELEMENTS));
    const workgroups = groups * chunks;
    const final = chunks === 1;
    const bytes = workgroups * (final ? 4 : WEBGPU_SUM_PARTIAL_BYTES);
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

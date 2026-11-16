import { TabgradError } from "../../shared/errors.js";

export type LinearDispatchLayout = "linear" | "grid";
export interface InvocationIndexSpace {
  readonly kind: "invocation";
  readonly workgroupSize: number;
  readonly elementsPerInvocation: number;
}
export interface CooperativeIndexSpace {
  readonly kind: "workgroup";
  readonly workgroupSize: number;
  readonly elementsPerWorkgroup: number;
}
export type LinearIndexSpace = InvocationIndexSpace | CooperativeIndexSpace;

export interface LinearDispatch {
  readonly layout: LinearDispatchLayout;
  readonly workgroups: number;
  readonly paddedWorkgroups: number;
  readonly x: number;
  readonly y: number;
  readonly z: 1;
}

function unsignedWord(value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > 0xffff_ffff) {
    throw new TabgradError("RESOURCE_EXHAUSTED", "GPU dispatch geometry exceeds its unsigned index domain.");
  }
}

/** No numerical policy: the kernel declares what one independent group covers. */
export function planLinearDispatch(elements: number, space: LinearIndexSpace, axis: number): LinearDispatch {
  unsignedWord(elements); unsignedWord(axis, 1); unsignedWord(space.workgroupSize, 1);
  const span = space.kind === "invocation" ? space.workgroupSize * space.elementsPerInvocation : space.elementsPerWorkgroup;
  unsignedWord(span, 1);
  if (space.kind === "invocation") unsignedWord(space.elementsPerInvocation, 1);
  const workgroups = Math.ceil(elements / span);
  const y = Math.max(1, Math.ceil(workgroups / axis));
  const x = Math.ceil(workgroups / y);
  const paddedWorkgroups = x * y;
  if (y > axis || !Number.isSafeInteger(paddedWorkgroups * span) || paddedWorkgroups * span > 0x1_0000_0000) {
    throw new TabgradError("RESOURCE_EXHAUSTED", "GPU dispatch cannot cover this extent with safe padded indices.");
  }
  return Object.freeze({ layout: y === 1 ? "linear" : "grid", workgroups, paddedWorkgroups, x, y, z: 1 });
}

/** Shared index spelling; numerical bodies and storage bindings stay with kernels. */
export function invocationEntry(layout: LinearDispatchLayout, workgroupSize: number): { readonly signature: string; readonly index: string } {
  return {
    signature: `fn main(@builtin(global_invocation_id) position: vec3<u32>${layout === "grid" ? ", @builtin(num_workgroups) grid: vec3<u32>" : ""}) {`,
    index: layout === "linear" ? "position.x" : `(position.x + position.y * grid.x * ${workgroupSize}u)`,
  };
}

/** Padded cooperative groups return uniformly, before any workgroup barrier. */
export function cooperativeEntry(layout: LinearDispatchLayout, span: number, count: string): {
  readonly signature: string; readonly index: string; readonly guard: string;
} {
  return {
    signature: `fn main(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3<u32>${layout === "grid" ? ", @builtin(num_workgroups) grid: vec3<u32>" : ""}) {`,
    index: layout === "linear" ? "group.x" : "linear_group",
    guard: layout === "linear" ? "" : `\n  let linear_group = group.x + group.y * grid.x;\n  if linear_group >= max(1u, ${count} / ${span}u + select(0u, 1u, ${count} % ${span}u != 0u)) { return; }`,
  };
}

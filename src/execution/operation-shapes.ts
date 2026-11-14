import { pointwiseGeometry, type BroadcastGeometry } from "./broadcast-geometry.js";

/** Family policy registration is shared by admission and reconstruction. */
export interface OperationShapePolicy {
  plan(shapes: readonly (readonly number[])[]): BroadcastGeometry;
}

export const POINTWISE_SHAPE_POLICY: OperationShapePolicy = Object.freeze({ plan: pointwiseGeometry });

const policies: Readonly<Record<string, OperationShapePolicy | undefined>> = Object.freeze({
  "add-f32": POINTWISE_SHAPE_POLICY,
  "mul-f32": POINTWISE_SHAPE_POLICY,
});

export function operationShapePolicy(kind: string): OperationShapePolicy | undefined {
  return Object.hasOwn(policies, kind) ? policies[kind] : undefined;
}

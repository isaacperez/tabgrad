import { pointwiseGeometry, type BroadcastGeometry } from "./broadcast-geometry.js";

/** A shape law is independent of the number of operands using it. */
export interface OperationShapePolicy {
  plan(shapes: readonly (readonly number[])[]): BroadcastGeometry;
}

export const POINTWISE_SHAPE_POLICY: OperationShapePolicy = Object.freeze({ plan: pointwiseGeometry });

/** One operation binding owns arity; admission and reconstruction share it. */
export interface OperationShapeContract {
  readonly arity: number;
  readonly policy: OperationShapePolicy;
}

const BINARY_POINTWISE_CONTRACT: OperationShapeContract = Object.freeze({ arity: 2, policy: POINTWISE_SHAPE_POLICY });

const contracts: Readonly<Record<string, OperationShapeContract | undefined>> = Object.freeze({
  "add-f32": BINARY_POINTWISE_CONTRACT,
  "mul-f32": BINARY_POINTWISE_CONTRACT,
});

export function operationShapeContract(kind: string): OperationShapeContract | undefined {
  return Object.hasOwn(contracts, kind) ? contracts[kind] : undefined;
}

export function assertOperationArity(contract: OperationShapeContract, count: number): void {
  if (count !== contract.arity) throw new TypeError("Shaped computation has invalid arity.");
}

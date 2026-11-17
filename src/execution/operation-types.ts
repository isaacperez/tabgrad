import type { TensorDType } from "../shared/tensor-dtype.js";

/** A fixed tensor signature, independent of shape, storage and device lifetime. */
export interface TensorTypePolicy<DType extends string = TensorDType> {
  readonly inputs: readonly DType[];
  readonly result: DType;
}

export function fixedTensorTypePolicy<DType extends string>(inputs: readonly DType[], result: DType): TensorTypePolicy<DType> {
  return Object.freeze({ inputs: Object.freeze([...inputs]), result });
}

/** Slot projection lets reconstruction use the same relation without copying operands. */
export function resolveTensorType<DType extends string>(policy: TensorTypePolicy<DType>,
  values: readonly { readonly dtype: string }[], slots?: readonly number[]): DType | undefined {
  if ((slots?.length ?? values.length) !== policy.inputs.length) return undefined;
  for (let index = 0; index < policy.inputs.length; index++) {
    const slot = slots === undefined ? index : slots[index]!;
    if ((slots !== undefined && (!Number.isSafeInteger(slot) || slot < 0))
      || values[slot]?.dtype !== policy.inputs[index]) return undefined;
  }
  return policy.result;
}

const UNARY_FLOAT32 = fixedTensorTypePolicy(["float32"], "float32");
const BINARY_FLOAT32 = fixedTensorTypePolicy(["float32", "float32"], "float32");
const BINARY_FLOAT16 = fixedTensorTypePolicy(["float16", "float16"], "float16");

interface OperationTypeContract {
  readonly types: TensorTypePolicy;
  readonly coefficient: "none" | "binary32";
}

const UNARY_CONTRACT = Object.freeze({ types: UNARY_FLOAT32, coefficient: "none" } as const);
const BINARY_CONTRACT = Object.freeze({ types: BINARY_FLOAT32, coefficient: "none" } as const);
const CONTRACTS = Object.freeze({
  "add-f32": BINARY_CONTRACT,
  "add-alpha-f32": Object.freeze({ types: BINARY_FLOAT32, coefficient: "binary32" } as const),
  "mul-f32": BINARY_CONTRACT,
  "add-f16": Object.freeze({ types: BINARY_FLOAT16, coefficient: "none" } as const),
  "mul-f16": Object.freeze({ types: BINARY_FLOAT16, coefficient: "none" } as const),
  "sum-f32": UNARY_CONTRACT,
  "expand-f32": UNARY_CONTRACT,
  "matmul-f32": BINARY_CONTRACT,
  "reduce-f32": UNARY_CONTRACT,
} satisfies Readonly<Record<string, OperationTypeContract>>);

export type ComputationKind = keyof typeof CONTRACTS;

export function operationTypeContract(kind: string): OperationTypeContract | undefined {
  return Object.hasOwn(CONTRACTS, kind) ? CONTRACTS[kind as ComputationKind] : undefined;
}

/** These bindings describe the supported state domains, not universal dtype laws. */
export const GRADIENT_STATE_TYPES = UNARY_FLOAT32;
export const DEFAULT_GRADIENT_ASSIGNMENT_TYPES = BINARY_FLOAT32;
export const PERSISTENT_COPY_TYPES = BINARY_FLOAT32;

export function assertComputationCoefficient(kind: string, alphaBits: number | undefined): void {
  const contract = operationTypeContract(kind);
  if (contract === undefined) throw new TypeError("Unsupported numerical computation.");
  if (contract.coefficient === "binary32") {
    if (!Number.isInteger(alphaBits) || alphaBits! < 0 || alphaBits! > 0xffff_ffff) {
      throw new TypeError("Coefficient addition requires captured binary32 bits.");
    }
  } else if (alphaBits !== undefined) {
    throw new TypeError("This operation has no coefficient.");
  }
}

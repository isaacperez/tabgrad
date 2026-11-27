import { pointwiseGeometry } from "./broadcast-geometry.js";
import { assertMatrixOrientation, matrixGeometry } from "./matrix-geometry.js";
import { BINARY_FLOAT32, fixedTensorTypePolicy, UNARY_FLOAT32, type TensorTypePolicy } from "./operation-types.js";

const POINTWISE = Object.freeze({ arity: 2, parameters: "none", geometry: "pointwise", plan: pointwiseGeometry } as const);
const MATRIX = Object.freeze({ arity: 2, parameters: "orientation", geometry: "matrix", plan: matrixGeometry } as const);
const RECEIVING = Object.freeze({ arity: 1, parameters: "none", geometry: "receiving", plan: pointwiseGeometry } as const);
const SCALAR = Object.freeze({ arity: 1, parameters: "none", geometry: "scalar", shape: Object.freeze([]) } as const);
// For these records the producer owns the output shape in format v8.
const UNARY_PRODUCED = Object.freeze({ arity: 1, parameters: "none", geometry: "produced" } as const);
const COEFFICIENT_ADD = Object.freeze({ arity: 2, parameters: "coefficient", geometry: "produced" } as const);

export type OperationFamily = typeof POINTWISE | typeof MATRIX | typeof RECEIVING | typeof SCALAR | typeof UNARY_PRODUCED | typeof COEFFICIENT_ADD;

function signature<Name extends string, Family extends OperationFamily>(operation: Name, family: Family, types: TensorTypePolicy) {
  if (types.inputs.length !== family.arity) throw new TypeError("Operation signature does not match its family arity.");
  return Object.freeze({ operation, family, types });
}

const BINARY_FLOAT16 = fixedTensorTypePolicy(["float16", "float16"], "float16");
const BINARY_BFLOAT16 = fixedTensorTypePolicy(["bfloat16", "bfloat16"], "bfloat16");

/** Finite numerical identities. Their spelling carries no shape or parameter semantics. */
export const COMPUTATION_SIGNATURES = Object.freeze({
  "add-f32": signature("add", POINTWISE, BINARY_FLOAT32),
  "add-alpha-f32": signature("add", COEFFICIENT_ADD, BINARY_FLOAT32),
  "mul-f32": signature("mul", POINTWISE, BINARY_FLOAT32),
  "add-f16": signature("add", POINTWISE, BINARY_FLOAT16),
  "mul-f16": signature("mul", POINTWISE, BINARY_FLOAT16),
  "sum-f32": signature("sum", SCALAR, UNARY_FLOAT32),
  "sum-f16": signature("sum", SCALAR, fixedTensorTypePolicy(["float16"], "float16")),
  "expand-f32": signature("expand", UNARY_PRODUCED, UNARY_FLOAT32),
  "matmul-f32": signature("matmul", MATRIX, BINARY_FLOAT32),
  "matmul-f16": signature("matmul", MATRIX, BINARY_FLOAT16),
  "add-bf16": signature("add", POINTWISE, BINARY_BFLOAT16),
  "mul-bf16": signature("mul", POINTWISE, BINARY_BFLOAT16),
  "sum-bf16": signature("sum", SCALAR, fixedTensorTypePolicy(["bfloat16"], "bfloat16")),
  "matmul-bf16": signature("matmul", MATRIX, BINARY_BFLOAT16),
  "reduce-f32": signature("reduce", RECEIVING, UNARY_FLOAT32),
});

export type ComputationKind = keyof typeof COMPUTATION_SIGNATURES;

export function computationSignature(kind: unknown): (typeof COMPUTATION_SIGNATURES)[ComputationKind] | undefined {
  return typeof kind === "string" && Object.hasOwn(COMPUTATION_SIGNATURES, kind)
    ? COMPUTATION_SIGNATURES[kind as ComputationKind] : undefined;
}

export function requireComputationSignature(kind: unknown): (typeof COMPUTATION_SIGNATURES)[ComputationKind] {
  const declared = computationSignature(kind);
  if (declared === undefined) throw new TypeError("Unsupported numerical computation.");
  return declared;
}

/** Physical adapters that need broadcast geometry use the same family. */
export function pointwiseFamily(kind: ComputationKind): typeof POINTWISE | undefined {
  const family = COMPUTATION_SIGNATURES[kind].family;
  return family.geometry === "pointwise" ? family : undefined;
}

export function assertComputationParameters(family: OperationFamily, alphaBits?: number, matrixFlags?: number): void {
  if (family.parameters === "coefficient") {
    if (!Number.isInteger(alphaBits) || alphaBits! < 0 || alphaBits! > 0xffff_ffff) {
      throw new TypeError("Coefficient addition requires captured binary32 bits.");
    }
  } else if (alphaBits !== undefined) {
    throw new TypeError("This operation has no coefficient.");
  }

  if (family.parameters === "orientation") assertMatrixOrientation(matrixFlags);
  else if (matrixFlags !== undefined) throw new TypeError("This operation has no matrix orientation.");
}

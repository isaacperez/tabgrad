import { pointwiseGeometry } from "./broadcast-geometry.js";
import { assertMatrixOrientation, matrixGeometry } from "./matrix-geometry.js";
import { axisReductionGeometry, type AxisReduction } from "./axis-geometry.js";
import { indexSelectionGeometry } from "./index-selection.js";
import { BINARY_FLOAT32, fixedTensorTypePolicy, UNARY_FLOAT32, type TensorTypePolicy } from "./operation-types.js";

const POINTWISE = Object.freeze({ arity: 2, parameters: "none", geometry: "pointwise", plan: pointwiseGeometry } as const);
const TERNARY_POINTWISE = Object.freeze({ ...POINTWISE, arity: 3 } as const);
const MATRIX = Object.freeze({ arity: 2, parameters: "orientation", geometry: "matrix", plan: matrixGeometry } as const);
const RECEIVING = Object.freeze({ arity: 1, parameters: "none", geometry: "receiving", plan: pointwiseGeometry } as const);
const SCALAR = Object.freeze({ arity: 1, parameters: "none", geometry: "scalar", shape: Object.freeze([]) } as const);
const AXIS_REDUCTION = Object.freeze({ arity: 1, parameters: "axis-reduction", geometry: "axis-reduction", plan: axisReductionGeometry } as const);
const INDEX_SELECTION = Object.freeze({ arity: 2, parameters: "selection-axis", geometry: "index-selection", plan: indexSelectionGeometry } as const);
// For these records the producer owns the output shape.
const UNARY_PRODUCED = Object.freeze({ arity: 1, parameters: "none", geometry: "produced" } as const);
const COEFFICIENT_ADD = Object.freeze({ arity: 2, parameters: "coefficient", geometry: "produced" } as const);

type PointwiseFamily = typeof POINTWISE | typeof TERNARY_POINTWISE;
export type OperationFamily = PointwiseFamily | typeof MATRIX | typeof RECEIVING | typeof SCALAR
  | typeof AXIS_REDUCTION | typeof INDEX_SELECTION | typeof UNARY_PRODUCED | typeof COEFFICIENT_ADD;

function signature<Name extends string, Family extends OperationFamily>(operation: Name, family: Family, types: TensorTypePolicy) {
  if (types.inputs.length !== family.arity) throw new TypeError("Operation signature does not match its family arity.");
  return Object.freeze({ operation, family, types });
}

const BINARY_FLOAT16 = fixedTensorTypePolicy(["float16", "float16"], "float16");
const BINARY_BFLOAT16 = fixedTensorTypePolicy(["bfloat16", "bfloat16"], "bfloat16");
const MASK_GRADIENT = fixedTensorTypePolicy(["bool", "float32"], "float32");

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
  "gt-f32": signature("gt", POINTWISE, fixedTensorTypePolicy(["float32", "float32"], "bool")),
  "where-f32": signature("where", TERNARY_POINTWISE, fixedTensorTypePolicy(["bool", "float32", "float32"], "float32")),
  "where-then-gradient-f32": signature("where-mask-gradient", POINTWISE, MASK_GRADIENT),
  "where-else-gradient-f32": signature("where-mask-gradient", POINTWISE, MASK_GRADIENT),
  "sum-bf16": signature("sum", SCALAR, fixedTensorTypePolicy(["bfloat16"], "bfloat16")),
  "matmul-bf16": signature("matmul", MATRIX, BINARY_BFLOAT16),
  "reduce-f32": signature("reduce", RECEIVING, UNARY_FLOAT32),
  "argmax-f32": signature("argmax", AXIS_REDUCTION, fixedTensorTypePolicy(["float32"], "int64")),
  "argmax-i32": signature("argmax", AXIS_REDUCTION, fixedTensorTypePolicy(["int32"], "int64")),
  "argmax-i64": signature("argmax", AXIS_REDUCTION, fixedTensorTypePolicy(["int64"], "int64")),
  "index-select-f32-i32": signature("index_select", INDEX_SELECTION, fixedTensorTypePolicy(["float32", "int32"], "float32")),
  "index-select-f32-i64": signature("index_select", INDEX_SELECTION, fixedTensorTypePolicy(["float32", "int64"], "float32")),
  "index-select-i32-i32": signature("index_select", INDEX_SELECTION, fixedTensorTypePolicy(["int32", "int32"], "int32")),
  "index-select-i32-i64": signature("index_select", INDEX_SELECTION, fixedTensorTypePolicy(["int32", "int64"], "int32")),
  "index-select-i64-i32": signature("index_select", INDEX_SELECTION, fixedTensorTypePolicy(["int64", "int32"], "int64")),
  "index-select-i64-i64": signature("index_select", INDEX_SELECTION, fixedTensorTypePolicy(["int64", "int64"], "int64")),
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
export function pointwiseFamily(kind: ComputationKind): PointwiseFamily | undefined {
  const family = COMPUTATION_SIGNATURES[kind].family;
  return family.geometry === "pointwise" ? family : undefined;
}

export function assertComputationParameters(family: OperationFamily, alphaBits?: number, matrixFlags?: number,
  reduction?: AxisReduction, selectionAxis?: number): void {
  if (family.parameters === "coefficient") {
    if (!Number.isInteger(alphaBits) || alphaBits! < 0 || alphaBits! > 0xffff_ffff) {
      throw new TypeError("Coefficient addition requires captured binary32 bits.");
    }
  } else if (alphaBits !== undefined) {
    throw new TypeError("This operation has no coefficient.");
  }

  if (family.parameters === "orientation") assertMatrixOrientation(matrixFlags);
  else if (matrixFlags !== undefined) throw new TypeError("This operation has no matrix orientation.");

  if (family.parameters === "axis-reduction") {
    if (typeof reduction !== "object" || reduction === null || typeof reduction.keepDim !== "boolean"
      || (reduction.axis !== null && (!Number.isSafeInteger(reduction.axis) || reduction.axis < 0))) {
      throw new TypeError("Axis reduction requires a normalized axis and dimension-retention flag.");
    }
  } else if (reduction !== undefined) throw new TypeError("This operation has no axis reduction.");

  if (family.parameters === "selection-axis") {
    if (!Number.isSafeInteger(selectionAxis) || selectionAxis! < 0) {
      throw new TypeError("Index selection requires a normalized axis.");
    }
  } else if (selectionAxis !== undefined) throw new TypeError("This operation has no selection axis.");
}

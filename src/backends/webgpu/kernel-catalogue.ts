import { pointwiseFamily, type ComputationKind, type COMPUTATION_SIGNATURES } from "../../execution/operation-contracts.js";
import type { CooperativeIndexSpace, InvocationIndexSpace, LinearDispatchLayout } from "./linear-dispatch.js";
import { WEBGPU_ADDITION_ARITHMETIC_SOURCE, WEBGPU_ADDITION_WORKGROUP_SIZE, createAdditionSource } from "./kernels/addition.js";
import { WEBGPU_MULTIPLICATION_ARITHMETIC_SOURCE, WEBGPU_MULTIPLICATION_WORKGROUP_SIZE, createMultiplicationSource } from "./kernels/multiplication.js";
import { WEBGPU_COEFFICIENT_UNIFORM_BYTES, WEBGPU_COEFFICIENT_ADDITION_WORKGROUP_SIZE, createCoefficientAdditionSource } from "./kernels/coefficient-addition.js";
import { WEBGPU_MATRIX_UNIFORM_BYTES, WEBGPU_MATRIX_WORKGROUP_SIZE, createMatrixSource } from "./kernels/matrix-product.js";
import { BFLOAT16_ADDITION_SOURCE, BFLOAT16_MULTIPLICATION_SOURCE } from "./kernels/bfloat16.js";
import { createBfloatMatrixSource } from "./kernels/matrix-product-bf16.js";
import { createBfloatSumSource } from "./kernels/sum-bf16.js";
import { createHalfMatrixSource } from "./kernels/matrix-product-f16.js";
import { WEBGPU_EXPANSION_WORKGROUP_SIZE, createExpansionSource } from "./kernels/expansion.js";
import { WEBGPU_SUM_GROUP_ELEMENTS, WEBGPU_SUM_PARTIAL_BYTES, WEBGPU_SUM_WORKGROUP_BYTES, WEBGPU_SUM_WORKGROUP_SIZE, createSumSource } from "./kernels/sum.js";
import { WEBGPU_HALF_SUM_GROUP_ELEMENTS, WEBGPU_HALF_SUM_PARTIAL_BYTES, WEBGPU_HALF_SUM_WORKGROUP_SIZE, createHalfSumSource } from "./kernels/sum-f16.js";
import { WEBGPU_POINTWISE_WORKGROUP_SIZE, pointwiseSource } from "./kernels/broadcast.js";
import { createReceivingSource, WEBGPU_RECEIVING_UNIFORM_BYTES } from "./kernels/receiving.js";
import { BINARY16_ARITHMETIC } from "./kernels/half.js";
import { PACKED16_WORKGROUP_SIZE, packed16PointwiseSource } from "./kernels/packed-pointwise.js";
import { BOOL_VALUES_PER_WORD, PACKED16_VALUES_PER_WORD } from "./kernels/packed-words.js";
import { createGreaterSource } from "./kernels/comparison.js";
import { createMaskGradientSource, createSelectionSource } from "./kernels/selection.js";
import { INDEX_SELECTION_PARAMETERS_BYTES, INDEX_SELECTION_WORKGROUP_SIZE, indexSelectionSource } from "./kernels/index-selection.js";
import { ARGMAX_PARAMETERS_BYTES, ARGMAX_PARTIAL_BYTES, ARGMAX_WORKGROUP_SIZE, argmaxSource } from "./kernels/argmax.js";

export type KernelKind = ComputationKind | `broadcast-${ComputationKind}`;
type ShaderSource = (layout: LinearDispatchLayout) => string;
export type PipelineKey = `${KernelKind}/${LinearDispatchLayout}`;

export interface PipelineSelection {
  readonly key: PipelineKey;
  readonly layout: LinearDispatchLayout;
  readonly source: ShaderSource;
  readonly minimumStorageBindings: number;
}

type IndexSpace = InvocationIndexSpace | CooperativeIndexSpace | { readonly kind: "window" };

export interface PhysicalKernel<Space extends IndexSpace = IndexSpace> {
  readonly kind: KernelKind;
  readonly indexSpace: Space;
  readonly linear: PipelineSelection;
  readonly grid: PipelineSelection | undefined;
}

export type UniformParameters = "coefficient" | "matrix";
type PointwiseKind = {
  [Kind in ComputationKind]: (typeof COMPUTATION_SIGNATURES)[Kind]["family"]["geometry"] extends "pointwise" ? Kind : never;
}[ComputationKind];

interface PointwiseRegistration {
  readonly strategy: "pointwise";
  readonly direct: PhysicalKernel<InvocationIndexSpace>;
  readonly projected: PhysicalKernel<InvocationIndexSpace>;
  readonly densePacket: boolean;
  readonly geometry: NonNullable<ReturnType<typeof pointwiseFamily>>;
}
type Registration = (
  | PointwiseRegistration
  | { readonly strategy: "dense"; readonly direct: PhysicalKernel<InvocationIndexSpace>; readonly uniform?: UniformParameters }
  | { readonly strategy: "sum"; readonly direct: PhysicalKernel<CooperativeIndexSpace>; readonly partialBytes: number }
  | { readonly strategy: "argmax"; readonly direct: PhysicalKernel<CooperativeIndexSpace> }
  | { readonly strategy: "index-selection"; readonly direct: PhysicalKernel<InvocationIndexSpace> }
  | { readonly strategy: "receiving"; readonly direct: PhysicalKernel<{ readonly kind: "window" }> }
) & { readonly supported?: (limits: GPUSupportedLimits) => boolean };

const POINTWISE_STORAGE_BINDINGS = 4;
const DENSE_PACKED_PACKET_BYTES = 3 * Uint32Array.BYTES_PER_ELEMENT;

function pipeline(kind: KernelKind, layout: LinearDispatchLayout, source: ShaderSource,
  minimumStorageBindings: number): PipelineSelection {
  return Object.freeze({ key: `${kind}/${layout}`, layout, source, minimumStorageBindings });
}

function physicalKernel<Space extends IndexSpace>(kind: KernelKind, indexSpace: Space, source: ShaderSource,
  minimumStorageBindings = 0): PhysicalKernel<Space> {
  const linear = pipeline(kind, "linear", source, minimumStorageBindings);
  const grid = indexSpace.kind === "window" ? undefined : pipeline(kind, "grid", source, minimumStorageBindings);
  return Object.freeze({ kind, indexSpace: Object.freeze(indexSpace), linear, grid });
}

function invocation(kind: KernelKind, workgroupSize: number, elementsPerInvocation: number, source: ShaderSource,
  minimumStorageBindings = 0): PhysicalKernel<InvocationIndexSpace> {
  return physicalKernel(kind, { kind: "invocation", workgroupSize, elementsPerInvocation }, source, minimumStorageBindings);
}

function vectorizedPointwise(workgroupSize: number, dense: ShaderSource, arithmetic: string, calculate: string)
  : (kind: PointwiseKind) => PointwiseRegistration {
  return kind => Object.freeze({
    strategy: "pointwise",
    direct: invocation(kind, workgroupSize, 1, dense),
    projected: invocation(`broadcast-${kind}`, WEBGPU_POINTWISE_WORKGROUP_SIZE, 1,
      layout => pointwiseSource(arithmetic, calculate, layout), POINTWISE_STORAGE_BINDINGS),
    densePacket: false,
    geometry: pointwiseFamily(kind)!,
  });
}

function bufferedPointwise(workgroupSize: number, lanes: number,
  source: (broadcast: boolean, layout: LinearDispatchLayout) => string): (kind: PointwiseKind) => Registration {
  return kind => {
    const geometry = pointwiseFamily(kind)!;
    const bindings = geometry.arity + 2;
    return Object.freeze({
      strategy: "pointwise",
      direct: invocation(kind, workgroupSize, lanes, layout => source(false, layout), bindings),
      projected: invocation(`broadcast-${kind}`, workgroupSize, lanes, layout => source(true, layout), bindings),
      densePacket: true,
      geometry,
      supported: (limits: GPUSupportedLimits) => limits.maxStorageBuffersPerShaderStage >= bindings
        && limits.maxBufferSize >= DENSE_PACKED_PACKET_BYTES && limits.maxStorageBufferBindingSize >= DENSE_PACKED_PACKET_BYTES,
    });
  };
}

function packed16Pointwise(arithmetic: string, calculate: string): (kind: PointwiseKind) => Registration {
  return bufferedPointwise(PACKED16_WORKGROUP_SIZE, PACKED16_VALUES_PER_WORD,
    (broadcast, layout) => packed16PointwiseSource(arithmetic, calculate, broadcast, layout));
}

function sumSupported(limits: GPUSupportedLimits, workgroupSize: number, workgroupBytes: number): boolean {
  return limits.maxBufferSize >= 16
    && limits.maxComputeWorkgroupStorageSize >= workgroupBytes
    && limits.maxComputeWorkgroupSizeX >= workgroupSize
    && limits.maxComputeInvocationsPerWorkgroup >= workgroupSize;
}

function sumKernel(workgroupSize: number, elementsPerWorkgroup: number, partialBytes: number,
  source: ShaderSource): (kind: ComputationKind) => Registration {
  if (!Number.isSafeInteger(elementsPerWorkgroup) || elementsPerWorkgroup < 2) {
    throw new TypeError("A sum kernel must shrink the input between stages.");
  }
  return kind => Object.freeze({
    strategy: "sum", direct: physicalKernel<CooperativeIndexSpace>(kind, { kind: "workgroup",
      workgroupSize, elementsPerWorkgroup }, source),
    partialBytes,
    supported: (limits: GPUSupportedLimits) => sumSupported(limits, workgroupSize, workgroupSize * partialBytes),
  });
}

function receivingSupported(limits: GPUSupportedLimits): boolean {
  return sumSupported(limits, WEBGPU_SUM_WORKGROUP_SIZE, WEBGPU_SUM_WORKGROUP_BYTES)
    && limits.maxBufferSize >= WEBGPU_RECEIVING_UNIFORM_BYTES
    && limits.maxStorageBuffersPerShaderStage >= 3;
}

function argmaxKernel(dtype: Parameters<typeof argmaxSource>[0]): (kind: ComputationKind) => Registration {
  return kind => Object.freeze({
    strategy: "argmax",
    direct: physicalKernel(kind, { kind: "workgroup" as const, workgroupSize: ARGMAX_WORKGROUP_SIZE,
      elementsPerWorkgroup: 1 }, layout => argmaxSource(dtype, layout), 2),
    supported: (limits: GPUSupportedLimits) =>
      sumSupported(limits, ARGMAX_WORKGROUP_SIZE, ARGMAX_WORKGROUP_SIZE * ARGMAX_PARTIAL_BYTES)
      && limits.maxBufferSize >= ARGMAX_PARAMETERS_BYTES && limits.maxUniformBufferBindingSize >= ARGMAX_PARAMETERS_BYTES
      && limits.maxStorageBuffersPerShaderStage >= 2,
  });
}

function indexSelectionKernel(kind: ComputationKind, dataWords: 1 | 2, indexWords: 1 | 2): Registration {
  return Object.freeze({
    strategy: "index-selection",
    direct: invocation(kind, INDEX_SELECTION_WORKGROUP_SIZE, 1,
      layout => indexSelectionSource(dataWords, indexWords, layout), 4),
    supported: (limits: GPUSupportedLimits) =>
      sumSupported(limits, INDEX_SELECTION_WORKGROUP_SIZE, 0)
      && limits.maxBufferSize >= INDEX_SELECTION_PARAMETERS_BYTES
      && limits.maxUniformBufferBindingSize >= INDEX_SELECTION_PARAMETERS_BYTES
      && limits.maxStorageBuffersPerShaderStage >= 4,
  });
}

const selectU32I32 = indexSelectionKernel("index-select-f32-i32", 1, 1);
const selectU32I64 = indexSelectionKernel("index-select-f32-i64", 1, 2);
const selectU64I32 = indexSelectionKernel("index-select-i64-i32", 2, 1);
const selectU64I64 = indexSelectionKernel("index-select-i64-i64", 2, 2);

function matrixKernel(elementsPerInvocation: number, source: ShaderSource): (kind: ComputationKind) => Registration {
  return kind => Object.freeze({
    strategy: "dense", direct: invocation(kind, WEBGPU_MATRIX_WORKGROUP_SIZE, elementsPerInvocation, source),
    uniform: "matrix", supported: (limits: GPUSupportedLimits) => limits.maxBufferSize >= WEBGPU_MATRIX_UNIFORM_BYTES,
  });
}

// The declaration order is also the order of the worker capability advertisement.
type KernelFactories = { readonly [Kind in ComputationKind]?: (kind: Kind) => Registration };
const factories: KernelFactories = Object.freeze({
  "add-f32": vectorizedPointwise(WEBGPU_ADDITION_WORKGROUP_SIZE, createAdditionSource,
    WEBGPU_ADDITION_ARITHMETIC_SOURCE, "add_binary32"),
  "add-alpha-f32": kind => Object.freeze({
    strategy: "dense", direct: invocation(kind, WEBGPU_COEFFICIENT_ADDITION_WORKGROUP_SIZE, 1, createCoefficientAdditionSource),
    uniform: "coefficient", supported: (limits: GPUSupportedLimits) => limits.maxBufferSize >= WEBGPU_COEFFICIENT_UNIFORM_BYTES,
  }),
  "matmul-f32": matrixKernel(1, createMatrixSource),
  "mul-f32": vectorizedPointwise(WEBGPU_MULTIPLICATION_WORKGROUP_SIZE, createMultiplicationSource,
    WEBGPU_MULTIPLICATION_ARITHMETIC_SOURCE, "multiply_binary32"),
  "add-f16": packed16Pointwise(BINARY16_ARITHMETIC, "add_binary16"),
  "mul-f16": packed16Pointwise(BINARY16_ARITHMETIC, "multiply_binary16"),
  "sum-f32": sumKernel(WEBGPU_SUM_WORKGROUP_SIZE, WEBGPU_SUM_GROUP_ELEMENTS, WEBGPU_SUM_PARTIAL_BYTES, createSumSource),
  "reduce-f32": kind => Object.freeze({
    strategy: "receiving", direct: physicalKernel(kind, { kind: "window" as const }, createReceivingSource),
    supported: receivingSupported,
  }),
  "expand-f32": kind => Object.freeze({
    strategy: "dense", direct: invocation(kind, WEBGPU_EXPANSION_WORKGROUP_SIZE, 1, createExpansionSource),
  }),
  "sum-f16": sumKernel(WEBGPU_HALF_SUM_WORKGROUP_SIZE, WEBGPU_HALF_SUM_GROUP_ELEMENTS, WEBGPU_HALF_SUM_PARTIAL_BYTES,
    createHalfSumSource),
  "matmul-f16": matrixKernel(PACKED16_VALUES_PER_WORD, createHalfMatrixSource),
  "add-bf16": packed16Pointwise(BFLOAT16_ADDITION_SOURCE, "add_bfloat16"),
  "mul-bf16": packed16Pointwise(BFLOAT16_MULTIPLICATION_SOURCE, "multiply_bfloat16"),
  "gt-f32": bufferedPointwise(WEBGPU_POINTWISE_WORKGROUP_SIZE, BOOL_VALUES_PER_WORD, createGreaterSource),
  "where-f32": bufferedPointwise(WEBGPU_POINTWISE_WORKGROUP_SIZE, 1, createSelectionSource),
  "where-then-gradient-f32": bufferedPointwise(WEBGPU_POINTWISE_WORKGROUP_SIZE, 1, createMaskGradientSource(true)),
  "where-else-gradient-f32": bufferedPointwise(WEBGPU_POINTWISE_WORKGROUP_SIZE, 1, createMaskGradientSource(false)),
  "sum-bf16": sumKernel(WEBGPU_SUM_WORKGROUP_SIZE, WEBGPU_SUM_GROUP_ELEMENTS, WEBGPU_SUM_PARTIAL_BYTES, createBfloatSumSource),
  "matmul-bf16": matrixKernel(PACKED16_VALUES_PER_WORD, createBfloatMatrixSource),
  "argmax-f32": argmaxKernel("float32"),
  "argmax-i32": argmaxKernel("int32"),
  "argmax-i64": argmaxKernel("int64"),
  "index-select-f32-i32": () => selectU32I32,
  "index-select-f32-i64": () => selectU32I64,
  "index-select-i32-i32": () => selectU32I32,
  "index-select-i32-i64": () => selectU32I64,
  "index-select-i64-i32": () => selectU64I32,
  "index-select-i64-i64": () => selectU64I64,
} satisfies KernelFactories);

const kinds = Object.keys(factories) as ComputationKind[];

function register<Kind extends ComputationKind>(kind: Kind): readonly [Kind, Registration] {
  return [kind, factories[kind]!(kind)];
}

const declarations: Readonly<Partial<Record<ComputationKind, Registration>>> = Object.freeze(
  Object.fromEntries(kinds.map(register)),
);

export function webGpuComputations(limits: GPUSupportedLimits): readonly ComputationKind[] {
  return Object.freeze(kinds.filter(kind => declarations[kind]!.supported?.(limits) ?? true));
}

export function webGpuKernel(kind: ComputationKind): Registration | undefined {
  return declarations[kind];
}

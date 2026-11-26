import { pointwiseFamily, type ComputationKind, type COMPUTATION_SIGNATURES } from "../../execution/operation-contracts.js";
import type { CooperativeIndexSpace, InvocationIndexSpace, LinearDispatchLayout } from "./linear-dispatch.js";
import { WEBGPU_ADDITION_ARITHMETIC_SOURCE, WEBGPU_ADDITION_WORKGROUP_SIZE, createAdditionSource } from "./kernels/addition.js";
import { WEBGPU_MULTIPLICATION_ARITHMETIC_SOURCE, WEBGPU_MULTIPLICATION_WORKGROUP_SIZE, createMultiplicationSource } from "./kernels/multiplication.js";
import { WEBGPU_COEFFICIENT_UNIFORM_BYTES, WEBGPU_COEFFICIENT_ADDITION_WORKGROUP_SIZE, createCoefficientAdditionSource } from "./kernels/coefficient-addition.js";
import { WEBGPU_MATRIX_UNIFORM_BYTES, WEBGPU_MATRIX_WORKGROUP_SIZE, createMatrixSource } from "./kernels/matrix-product.js";
import { WEBGPU_EXPANSION_WORKGROUP_SIZE, createExpansionSource } from "./kernels/expansion.js";
import { WEBGPU_SUM_GROUP_ELEMENTS, WEBGPU_SUM_WORKGROUP_BYTES, WEBGPU_SUM_WORKGROUP_SIZE, createSumSource } from "./kernels/sum.js";
import { WEBGPU_POINTWISE_WORKGROUP_SIZE, pointwiseSource } from "./kernels/broadcast.js";
import { createReceivingSource, WEBGPU_RECEIVING_UNIFORM_BYTES } from "./kernels/receiving.js";
import { BINARY16_ARITHMETIC } from "./kernels/half.js";
import { PACKED16_VALUES_PER_WORD, PACKED16_WORKGROUP_SIZE, packed16PointwiseSource } from "./kernels/packed-pointwise.js";

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
  | { readonly strategy: "sum"; readonly direct: PhysicalKernel<CooperativeIndexSpace> }
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

function packed16Supported(limits: GPUSupportedLimits): boolean {
  return limits.maxStorageBuffersPerShaderStage >= POINTWISE_STORAGE_BINDINGS
    && limits.maxBufferSize >= DENSE_PACKED_PACKET_BYTES && limits.maxStorageBufferBindingSize >= DENSE_PACKED_PACKET_BYTES;
}

function packed16Pointwise(arithmetic: string, calculate: string): (kind: PointwiseKind) => Registration {
  return kind => Object.freeze({
    strategy: "pointwise",
    direct: invocation(kind, PACKED16_WORKGROUP_SIZE, PACKED16_VALUES_PER_WORD,
      layout => packed16PointwiseSource(arithmetic, calculate, false, layout), POINTWISE_STORAGE_BINDINGS),
    projected: invocation(`broadcast-${kind}`, PACKED16_WORKGROUP_SIZE, PACKED16_VALUES_PER_WORD,
      layout => packed16PointwiseSource(arithmetic, calculate, true, layout), POINTWISE_STORAGE_BINDINGS),
    densePacket: true,
    geometry: pointwiseFamily(kind)!,
    supported: packed16Supported,
  });
}

function sumSupported(limits: GPUSupportedLimits): boolean {
  return limits.maxBufferSize >= 16
    && limits.maxComputeWorkgroupStorageSize >= WEBGPU_SUM_WORKGROUP_BYTES
    && limits.maxComputeWorkgroupSizeX >= WEBGPU_SUM_WORKGROUP_SIZE
    && limits.maxComputeInvocationsPerWorkgroup >= WEBGPU_SUM_WORKGROUP_SIZE;
}

function receivingSupported(limits: GPUSupportedLimits): boolean {
  return sumSupported(limits) && limits.maxBufferSize >= WEBGPU_RECEIVING_UNIFORM_BYTES
    && limits.maxStorageBuffersPerShaderStage >= 3;
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
  "matmul-f32": kind => Object.freeze({
    strategy: "dense", direct: invocation(kind, WEBGPU_MATRIX_WORKGROUP_SIZE, 1, createMatrixSource),
    uniform: "matrix", supported: (limits: GPUSupportedLimits) => limits.maxBufferSize >= WEBGPU_MATRIX_UNIFORM_BYTES,
  }),
  "mul-f32": vectorizedPointwise(WEBGPU_MULTIPLICATION_WORKGROUP_SIZE, createMultiplicationSource,
    WEBGPU_MULTIPLICATION_ARITHMETIC_SOURCE, "multiply_binary32"),
  "add-f16": packed16Pointwise(BINARY16_ARITHMETIC, "add_binary16"),
  "mul-f16": packed16Pointwise(BINARY16_ARITHMETIC, "multiply_binary16"),
  "sum-f32": kind => Object.freeze({
    strategy: "sum", direct: physicalKernel<CooperativeIndexSpace>(kind, { kind: "workgroup",
      workgroupSize: WEBGPU_SUM_WORKGROUP_SIZE, elementsPerWorkgroup: WEBGPU_SUM_GROUP_ELEMENTS }, createSumSource),
    supported: sumSupported,
  }),
  "reduce-f32": kind => Object.freeze({
    strategy: "receiving", direct: physicalKernel(kind, { kind: "window" as const }, createReceivingSource),
    supported: receivingSupported,
  }),
  "expand-f32": kind => Object.freeze({
    strategy: "dense", direct: invocation(kind, WEBGPU_EXPANSION_WORKGROUP_SIZE, 1, createExpansionSource),
  }),
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

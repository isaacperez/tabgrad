import type { ComputationKind } from "../../execution/operation-contracts.js";
import type { CooperativeIndexSpace, InvocationIndexSpace, LinearDispatchLayout } from "./linear-dispatch.js";
import { WEBGPU_ADDITION_ARITHMETIC_SOURCE, WEBGPU_ADDITION_WORKGROUP_SIZE, createAdditionSource } from "./kernels/addition.js";
import { WEBGPU_MULTIPLICATION_ARITHMETIC_SOURCE, WEBGPU_MULTIPLICATION_WORKGROUP_SIZE, createMultiplicationSource } from "./kernels/multiplication.js";
import { WEBGPU_COEFFICIENT_UNIFORM_BYTES, WEBGPU_COEFFICIENT_ADDITION_WORKGROUP_SIZE, createCoefficientAdditionSource } from "./kernels/coefficient-addition.js";
import { WEBGPU_MATRIX_UNIFORM_BYTES, WEBGPU_MATRIX_WORKGROUP_SIZE, createMatrixSource } from "./kernels/matrix-product.js";
import { WEBGPU_EXPANSION_WORKGROUP_SIZE, createExpansionSource } from "./kernels/expansion.js";
import { WEBGPU_SUM_GROUP_ELEMENTS, WEBGPU_SUM_WORKGROUP_BYTES, WEBGPU_SUM_WORKGROUP_SIZE, createSumSource } from "./kernels/sum.js";
import { WEBGPU_POINTWISE_WORKGROUP_SIZE, pointwiseSource } from "./kernels/broadcast.js";
import { WEBGPU_RECEIVING_SOURCE, WEBGPU_RECEIVING_UNIFORM_BYTES } from "./kernels/receiving.js";
import { BINARY16_ARITHMETIC } from "./kernels/half.js";
import { PACKED16_VALUES_PER_WORD, PACKED16_WORKGROUP_SIZE, packed16PointwiseSource } from "./kernels/packed-pointwise.js";

export type KernelKind = ComputationKind | `broadcast-${ComputationKind}`;
type ShaderSource = (layout: LinearDispatchLayout) => string;

export interface PhysicalKernel<Space = InvocationIndexSpace | CooperativeIndexSpace | { readonly kind: "window" }> {
  readonly kind: KernelKind;
  readonly indexSpace: Space;
  readonly source: ShaderSource;
  readonly minimumStorageBindings: number;
}

export type UniformParameters = "coefficient" | "matrix";
interface PointwiseRegistration {
  readonly strategy: "pointwise";
  readonly direct: PhysicalKernel<InvocationIndexSpace>;
  readonly projected: PhysicalKernel<InvocationIndexSpace>;
  readonly densePacket: boolean;
}
type Registration = (
  | PointwiseRegistration
  | { readonly strategy: "dense"; readonly direct: PhysicalKernel<InvocationIndexSpace>; readonly uniform?: UniformParameters }
  | { readonly strategy: "sum"; readonly direct: PhysicalKernel<CooperativeIndexSpace> }
  | { readonly strategy: "receiving"; readonly direct: PhysicalKernel<{ readonly kind: "window" }> }
) & { readonly supported?: (limits: GPUSupportedLimits) => boolean };

const POINTWISE_STORAGE_BINDINGS = 4;
const DENSE_PACKED_PACKET_BYTES = 3 * Uint32Array.BYTES_PER_ELEMENT;

function physicalKernel<Space>(kind: KernelKind, indexSpace: Space, source: ShaderSource,
  minimumStorageBindings = 0): PhysicalKernel<Space> {
  return Object.freeze({ kind, indexSpace: Object.freeze(indexSpace), source, minimumStorageBindings });
}

function invocation(kind: KernelKind, workgroupSize: number, elementsPerInvocation: number, source: ShaderSource,
  minimumStorageBindings = 0): PhysicalKernel<InvocationIndexSpace> {
  return physicalKernel(kind, { kind: "invocation", workgroupSize, elementsPerInvocation }, source, minimumStorageBindings);
}

function vectorizedPointwise(kind: ComputationKind, workgroupSize: number, dense: ShaderSource,
  arithmetic: string, calculate: string): PointwiseRegistration {
  return Object.freeze({
    strategy: "pointwise",
    direct: invocation(kind, workgroupSize, 1, dense),
    projected: invocation(`broadcast-${kind}`, WEBGPU_POINTWISE_WORKGROUP_SIZE, 1,
      layout => pointwiseSource(arithmetic, calculate, layout), POINTWISE_STORAGE_BINDINGS),
    densePacket: false,
  });
}

function packed16Supported(limits: GPUSupportedLimits): boolean {
  return limits.maxStorageBuffersPerShaderStage >= POINTWISE_STORAGE_BINDINGS
    && limits.maxBufferSize >= DENSE_PACKED_PACKET_BYTES && limits.maxStorageBufferBindingSize >= DENSE_PACKED_PACKET_BYTES;
}

function packed16Pointwise(kind: ComputationKind, arithmetic: string, calculate: string): Registration {
  return Object.freeze({
    strategy: "pointwise",
    direct: invocation(kind, PACKED16_WORKGROUP_SIZE, PACKED16_VALUES_PER_WORD,
      layout => packed16PointwiseSource(arithmetic, calculate, false, layout), POINTWISE_STORAGE_BINDINGS),
    projected: invocation(`broadcast-${kind}`, PACKED16_WORKGROUP_SIZE, PACKED16_VALUES_PER_WORD,
      layout => packed16PointwiseSource(arithmetic, calculate, true, layout), POINTWISE_STORAGE_BINDINGS),
    densePacket: true,
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
const declarations: Readonly<Partial<Record<ComputationKind, Registration>>> = Object.freeze({
  "add-f32": vectorizedPointwise("add-f32", WEBGPU_ADDITION_WORKGROUP_SIZE, createAdditionSource,
    WEBGPU_ADDITION_ARITHMETIC_SOURCE, "add_binary32"),
  "add-alpha-f32": Object.freeze({
    strategy: "dense", direct: invocation("add-alpha-f32", WEBGPU_COEFFICIENT_ADDITION_WORKGROUP_SIZE, 1, createCoefficientAdditionSource),
    uniform: "coefficient", supported: (limits: GPUSupportedLimits) => limits.maxBufferSize >= WEBGPU_COEFFICIENT_UNIFORM_BYTES,
  }),
  "matmul-f32": Object.freeze({
    strategy: "dense", direct: invocation("matmul-f32", WEBGPU_MATRIX_WORKGROUP_SIZE, 1, createMatrixSource),
    uniform: "matrix", supported: (limits: GPUSupportedLimits) => limits.maxBufferSize >= WEBGPU_MATRIX_UNIFORM_BYTES,
  }),
  "mul-f32": vectorizedPointwise("mul-f32", WEBGPU_MULTIPLICATION_WORKGROUP_SIZE, createMultiplicationSource,
    WEBGPU_MULTIPLICATION_ARITHMETIC_SOURCE, "multiply_binary32"),
  "add-f16": packed16Pointwise("add-f16", BINARY16_ARITHMETIC, "add_binary16"),
  "mul-f16": packed16Pointwise("mul-f16", BINARY16_ARITHMETIC, "multiply_binary16"),
  "sum-f32": Object.freeze({
    strategy: "sum", direct: physicalKernel<CooperativeIndexSpace>("sum-f32", { kind: "workgroup",
      workgroupSize: WEBGPU_SUM_WORKGROUP_SIZE, elementsPerWorkgroup: WEBGPU_SUM_GROUP_ELEMENTS }, createSumSource),
    supported: sumSupported,
  }),
  "reduce-f32": Object.freeze({
    strategy: "receiving", direct: physicalKernel("reduce-f32", { kind: "window" as const }, () => WEBGPU_RECEIVING_SOURCE),
    supported: receivingSupported,
  }),
  "expand-f32": Object.freeze({
    strategy: "dense", direct: invocation("expand-f32", WEBGPU_EXPANSION_WORKGROUP_SIZE, 1, createExpansionSource),
  }),
} satisfies Partial<Record<ComputationKind, Registration>>);

const kinds = Object.keys(declarations) as ComputationKind[];

export function webGpuComputations(limits: GPUSupportedLimits): readonly ComputationKind[] {
  return Object.freeze(kinds.filter(kind => declarations[kind]!.supported?.(limits) ?? true));
}

export function webGpuKernel(kind: ComputationKind): Registration | undefined {
  return declarations[kind];
}

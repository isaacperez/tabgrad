import { TabgradError } from "../../shared/errors.js";
import type { ExecutableProgram, LoweredComputation } from "../../execution/executable-program.js";
import { tensorElementCount } from "../../runtime/tensor-shape.js";
import { pointwiseGeometry, receivingGeometry } from "../../execution/broadcast-geometry.js";
import { pointwiseFamily } from "../../execution/operation-contracts.js";
import { pointwiseParameters, receivingParameters, receivingStages, type ReceivingStage } from "./broadcast-dispatch.js";
import { planLinearDispatch, type LinearDispatch, type LinearDispatchLayout, type LinearIndexSpace } from "./linear-dispatch.js";
import { reductionStages, type ReductionStage } from "./reduction-stages.js";
import { WEBGPU_ADDITION_SOURCE, WEBGPU_ADDITION_WORKGROUP_SIZE, WEBGPU_ADDITION_ARITHMETIC_SOURCE, createAdditionSource } from "./kernels/addition.js";
import { WEBGPU_MULTIPLICATION_SOURCE, WEBGPU_MULTIPLICATION_WORKGROUP_SIZE, WEBGPU_MULTIPLICATION_ARITHMETIC_SOURCE, createMultiplicationSource } from "./kernels/multiplication.js";
import { WEBGPU_COEFFICIENT_ADDITION_SOURCE, WEBGPU_COEFFICIENT_ADDITION_WORKGROUP_SIZE, createCoefficientAdditionSource } from "./kernels/coefficient-addition.js";
import { WEBGPU_MATRIX_SOURCE, WEBGPU_MATRIX_WORKGROUP_SIZE, createMatrixSource } from "./kernels/matrix-product.js";
import { WEBGPU_EXPANSION_SOURCE, WEBGPU_EXPANSION_WORKGROUP_SIZE, createExpansionSource } from "./kernels/expansion.js";
import { WEBGPU_SUM_SOURCE, WEBGPU_SUM_GROUP_ELEMENTS, WEBGPU_SUM_WORKGROUP_SIZE, createSumSource } from "./kernels/sum.js";
import { WEBGPU_BROADCAST_ADDITION_SOURCE, WEBGPU_BROADCAST_MULTIPLICATION_SOURCE, WEBGPU_POINTWISE_WORKGROUP_SIZE, pointwiseSource } from "./kernels/broadcast.js";
import { WEBGPU_RECEIVING_SOURCE } from "./kernels/receiving.js";
import { halfPointwiseSource, WEBGPU_HALF_WORKGROUP_SIZE } from "./kernels/half.js";

type KernelKind = LoweredComputation["kind"] | "broadcast-add-f32" | "broadcast-mul-f32" | "broadcast-add-f16" | "broadcast-mul-f16";
export type PipelineKey = `${KernelKind}/${LinearDispatchLayout}`;
export interface PipelineSelection {
  readonly key: PipelineKey;
  readonly kind: KernelKind;
  readonly layout: LinearDispatchLayout;
}

interface KernelDefinition {
  readonly indexSpace: LinearIndexSpace | { readonly kind: "window" };
  readonly original: string;
  readonly source: (layout: LinearDispatchLayout) => string;
}

// This finite physical table is exhaustive over current lowering, never shape-keyed.
const KERNELS = Object.freeze({
  "add-f16": { indexSpace: { kind: "invocation", workgroupSize: WEBGPU_HALF_WORKGROUP_SIZE, elementsPerInvocation: 2 }, original: halfPointwiseSource("add"), source: layout => halfPointwiseSource("add", false, layout) },
  "mul-f16": { indexSpace: { kind: "invocation", workgroupSize: WEBGPU_HALF_WORKGROUP_SIZE, elementsPerInvocation: 2 }, original: halfPointwiseSource("mul"), source: layout => halfPointwiseSource("mul", false, layout) },
  "broadcast-add-f16": { indexSpace: { kind: "invocation", workgroupSize: WEBGPU_HALF_WORKGROUP_SIZE, elementsPerInvocation: 2 }, original: halfPointwiseSource("add", true), source: layout => halfPointwiseSource("add", true, layout) },
  "broadcast-mul-f16": { indexSpace: { kind: "invocation", workgroupSize: WEBGPU_HALF_WORKGROUP_SIZE, elementsPerInvocation: 2 }, original: halfPointwiseSource("mul", true), source: layout => halfPointwiseSource("mul", true, layout) },
  "add-f32": { indexSpace: { kind: "invocation", workgroupSize: WEBGPU_ADDITION_WORKGROUP_SIZE, elementsPerInvocation: 1 }, original: WEBGPU_ADDITION_SOURCE, source: createAdditionSource },
  "mul-f32": { indexSpace: { kind: "invocation", workgroupSize: WEBGPU_MULTIPLICATION_WORKGROUP_SIZE, elementsPerInvocation: 1 }, original: WEBGPU_MULTIPLICATION_SOURCE, source: createMultiplicationSource },
  "add-alpha-f32": { indexSpace: { kind: "invocation", workgroupSize: WEBGPU_COEFFICIENT_ADDITION_WORKGROUP_SIZE, elementsPerInvocation: 1 }, original: WEBGPU_COEFFICIENT_ADDITION_SOURCE, source: createCoefficientAdditionSource },
  "expand-f32": { indexSpace: { kind: "invocation", workgroupSize: WEBGPU_EXPANSION_WORKGROUP_SIZE, elementsPerInvocation: 1 }, original: WEBGPU_EXPANSION_SOURCE, source: createExpansionSource },
  "matmul-f32": { indexSpace: { kind: "invocation", workgroupSize: WEBGPU_MATRIX_WORKGROUP_SIZE, elementsPerInvocation: 1 }, original: WEBGPU_MATRIX_SOURCE, source: createMatrixSource },
  "sum-f32": { indexSpace: { kind: "workgroup", workgroupSize: WEBGPU_SUM_WORKGROUP_SIZE, elementsPerWorkgroup: WEBGPU_SUM_GROUP_ELEMENTS }, original: WEBGPU_SUM_SOURCE, source: createSumSource },
  "reduce-f32": { indexSpace: { kind: "window" }, original: WEBGPU_RECEIVING_SOURCE, source: () => WEBGPU_RECEIVING_SOURCE },
  "broadcast-add-f32": { indexSpace: { kind: "invocation", workgroupSize: WEBGPU_POINTWISE_WORKGROUP_SIZE, elementsPerInvocation: 1 }, original: WEBGPU_BROADCAST_ADDITION_SOURCE,
    source: layout => pointwiseSource(WEBGPU_ADDITION_ARITHMETIC_SOURCE, "add_binary32", layout) },
  "broadcast-mul-f32": { indexSpace: { kind: "invocation", workgroupSize: WEBGPU_POINTWISE_WORKGROUP_SIZE, elementsPerInvocation: 1 }, original: WEBGPU_BROADCAST_MULTIPLICATION_SOURCE,
    source: layout => pointwiseSource(WEBGPU_MULTIPLICATION_ARITHMETIC_SOURCE, "multiply_binary32", layout) },
} as const satisfies Readonly<Record<KernelKind, KernelDefinition>>);

export function selectPipeline(kind: KernelKind, layout: LinearDispatchLayout): PipelineSelection {
  if (KERNELS[kind].indexSpace.kind === "window" && layout !== "linear") {
    throw new TabgradError("BACKEND_CAPABILITY_MISMATCH", "Windowed GPU kernels require their own immutable-offset layout.");
  }
  return { key: `${kind}/${layout}`, kind, layout };
}

export function pipelineSource(pipeline: PipelineSelection): string {
  const kernel = KERNELS[pipeline.kind];
  return pipeline.layout === "linear" ? kernel.original : kernel.source(pipeline.layout);
}

interface SumStage extends ReductionStage {
  readonly dispatch: LinearDispatch;
  readonly pipeline: PipelineSelection;
}

export type KernelDispatchPlan =
  | { readonly path: "dense"; readonly dispatch: LinearDispatch; readonly pipeline: PipelineSelection }
  | { readonly path: "pointwise"; readonly dispatch: LinearDispatch; readonly pipeline: PipelineSelection; readonly words: Uint32Array }
  | { readonly path: "sum"; readonly stages: readonly SumStage[] }
  | { readonly path: "receiving"; readonly stages: readonly ReceivingStage[]; readonly words: Uint32Array;
      readonly terms: number; readonly groups: number; readonly pipeline: PipelineSelection };

interface DispatchLimits {
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxComputeWorkgroupsPerDimension: number;
}

/** Derive finite invocation metadata before compilation, writes or allocation. */
export function planKernelDispatch(computation: LoweredComputation, program: ExecutableProgram, limits: DispatchLimits): KernelDispatchPlan {
  const output = program.values[computation.output]!;
  const elements = tensorElementCount(output.shape);
  const inputShapes = computation.inputs.map(slot => program.values[slot]!.shape);
  const axis = limits.maxComputeWorkgroupsPerDimension;
  if (computation.kind === "add-f16" || computation.kind === "mul-f16") {
    const broadcast = elements !== 0 && inputShapes.some(shape => tensorElementCount(shape) !== elements);
    const kind = broadcast ? computation.kind === "add-f16" ? "broadcast-add-f16" : "broadcast-mul-f16" : computation.kind;
    const words = broadcast ? pointwiseParameters(pointwiseFamily(computation.kind)!.plan(inputShapes), limits)
      : new Uint32Array([0, elements, 2]);
    words[2] = 2;
    const dispatch = planLinearDispatch(elements, KERNELS[kind].indexSpace, axis);
    return { path: "pointwise", dispatch, words, pipeline: selectPipeline(kind, dispatch.layout) };
  }
  if (computation.kind === "sum-f32") {
    const stages = reductionStages(tensorElementCount(inputShapes[0]!), 1, limits).map(stage => {
      const dispatch = planLinearDispatch(Math.max(1, stage.count), KERNELS["sum-f32"].indexSpace, axis);
      return { ...stage, dispatch, pipeline: selectPipeline("sum-f32", dispatch.layout) };
    });
    return { path: "sum", stages };
  }
  if (computation.kind === "reduce-f32") {
    const projection = receivingGeometry(pointwiseGeometry([inputShapes[0]!, output.shape]), 1);
    return { path: "receiving", stages: receivingStages(projection, limits), words: receivingParameters(projection, limits),
      terms: projection.terms, groups: projection.groups, pipeline: selectPipeline("reduce-f32", "linear") };
  }
  if ((computation.kind === "add-f32" || computation.kind === "mul-f32") && elements !== 0
    && inputShapes.some(shape => tensorElementCount(shape) !== elements)) {
    const kind = computation.kind === "add-f32" ? "broadcast-add-f32" : "broadcast-mul-f32";
    const words = pointwiseParameters(pointwiseFamily(computation.kind)!.plan(inputShapes), limits);
    const dispatch = planLinearDispatch(elements, { ...KERNELS[kind].indexSpace, elementsPerInvocation: words[2]! }, axis);
    return { path: "pointwise", dispatch, words, pipeline: selectPipeline(kind, dispatch.layout) };
  }
  const space = KERNELS[computation.kind].indexSpace;
  if (space.kind !== "invocation") throw new TabgradError("BACKEND_CAPABILITY_MISMATCH", "GPU kernel requires its declared cooperative or windowed strategy.");
  const dispatch = planLinearDispatch(elements, space, axis);
  return { path: "dense", dispatch, pipeline: selectPipeline(computation.kind, dispatch.layout) };
}

export function requestedPipelines(plan: KernelDispatchPlan): readonly PipelineSelection[] {
  return plan.path === "sum" ? plan.stages.map(stage => stage.pipeline) : [plan.pipeline];
}

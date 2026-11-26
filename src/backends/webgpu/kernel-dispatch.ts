import { TabgradError } from "../../shared/errors.js";
import type { ExecutableProgram, LoweredComputation } from "../../execution/executable-program.js";
import { tensorElementCount } from "../../runtime/tensor-shape.js";
import { pointwiseGeometry, receivingGeometry } from "../../execution/broadcast-geometry.js";
import { pointwiseFamily } from "../../execution/operation-contracts.js";
import { pointwiseParameters, receivingParameters, receivingStages, type BroadcastDispatchLimits, type ReceivingStage } from "./broadcast-dispatch.js";
import { planLinearDispatch, type LinearDispatch, type LinearDispatchLayout } from "./linear-dispatch.js";
import { reductionStages, type ReductionStage } from "./reduction-stages.js";
import { webGpuKernel, type KernelKind, type PhysicalKernel, type UniformParameters } from "./kernel-catalogue.js";

export type PipelineKey = `${KernelKind}/${LinearDispatchLayout}`;
export interface PipelineSelection {
  readonly key: PipelineKey;
  readonly layout: LinearDispatchLayout;
  readonly kernel: PhysicalKernel;
}

export function selectPipeline(kernel: PhysicalKernel, layout: LinearDispatchLayout): PipelineSelection {
  if (kernel.indexSpace.kind === "window" && layout !== "linear") {
    throw new TabgradError("BACKEND_CAPABILITY_MISMATCH", "Windowed GPU kernels require their own immutable-offset layout.");
  }
  return { key: `${kernel.kind}/${layout}`, kernel, layout };
}

export function pipelineSource(pipeline: PipelineSelection): string {
  return pipeline.kernel.source(pipeline.layout);
}

interface SumStage extends ReductionStage {
  readonly dispatch: LinearDispatch;
  readonly pipeline: PipelineSelection;
}

export type KernelDispatchPlan =
  | { readonly path: "dense"; readonly dispatch: LinearDispatch; readonly pipeline: PipelineSelection;
      readonly uniform: UniformParameters | undefined }
  | { readonly path: "pointwise"; readonly dispatch: LinearDispatch; readonly pipeline: PipelineSelection; readonly words: Uint32Array }
  | { readonly path: "sum"; readonly stages: readonly SumStage[] }
  | { readonly path: "receiving"; readonly stages: readonly ReceivingStage[]; readonly words: Uint32Array;
      readonly terms: number; readonly groups: number; readonly pipeline: PipelineSelection };

/** Derive finite invocation metadata before compilation, writes or allocation. */
export function planKernelDispatch(computation: LoweredComputation, program: ExecutableProgram,
  limits: BroadcastDispatchLimits): KernelDispatchPlan {
  const registration = webGpuKernel(computation.kind);
  if (registration === undefined) {
    throw new TabgradError("BACKEND_CAPABILITY_MISMATCH", "The selected backend does not support this computation signature.");
  }
  const output = program.values[computation.output]!;
  const axis = limits.maxComputeWorkgroupsPerDimension;
  switch (registration.strategy) {
    case "pointwise": {
      const elements = tensorElementCount(output.shape);
      const broadcast = elements !== 0 && computation.inputs.some(slot => tensorElementCount(program.values[slot]!.shape) !== elements);
      const kernel = broadcast ? registration.projected : registration.direct;
      const fixedWidth = registration.densePacket ? kernel.indexSpace.elementsPerInvocation : undefined;
      if (broadcast || fixedWidth !== undefined) {
        const words = broadcast
          ? pointwiseParameters(pointwiseFamily(computation.kind)!.plan(computation.inputs.map(slot => program.values[slot]!.shape)), limits, fixedWidth)
          : new Uint32Array([0, elements, fixedWidth!]);
        const space = fixedWidth === undefined ? { ...kernel.indexSpace, elementsPerInvocation: words[2]! } : kernel.indexSpace;
        const dispatch = planLinearDispatch(elements, space, axis);
        return { path: "pointwise", dispatch, words, pipeline: selectPipeline(kernel, dispatch.layout) };
      }
      const dispatch = planLinearDispatch(elements, kernel.indexSpace, axis);
      return { path: "dense", dispatch, pipeline: selectPipeline(kernel, dispatch.layout), uniform: undefined };
    }
    case "dense": {
      const dispatch = planLinearDispatch(tensorElementCount(output.shape), registration.direct.indexSpace, axis);
      return { path: "dense", dispatch, pipeline: selectPipeline(registration.direct, dispatch.layout), uniform: registration.uniform };
    }
    case "sum": {
      const count = tensorElementCount(program.values[computation.inputs[0]!]!.shape);
      const stages = reductionStages(count, 1, limits).map(stage => {
        const dispatch = planLinearDispatch(Math.max(1, stage.count), registration.direct.indexSpace, axis);
        return { ...stage, dispatch, pipeline: selectPipeline(registration.direct, dispatch.layout) };
      });
      return { path: "sum", stages };
    }
    case "receiving": {
      const projection = receivingGeometry(pointwiseGeometry([program.values[computation.inputs[0]!]!.shape, output.shape]), 1);
      return { path: "receiving", stages: receivingStages(projection, limits), words: receivingParameters(projection, limits),
        terms: projection.terms, groups: projection.groups, pipeline: selectPipeline(registration.direct, "linear") };
    }
  }
}

export function requestedPipelines(plan: KernelDispatchPlan): readonly PipelineSelection[] {
  return plan.path === "sum" ? plan.stages.map(stage => stage.pipeline) : [plan.pipeline];
}

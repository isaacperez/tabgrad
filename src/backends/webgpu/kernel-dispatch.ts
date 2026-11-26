import { TabgradError } from "../../shared/errors.js";
import type { ExecutableProgram, LoweredComputation } from "../../execution/executable-program.js";
import { tensorElementCount } from "../../runtime/tensor-shape.js";
import { pointwiseGeometry, receivingGeometry } from "../../execution/broadcast-geometry.js";
import { pointwiseParameters, receivingParameters, receivingStages, type BroadcastDispatchLimits, type ReceivingStage } from "./broadcast-dispatch.js";
import { planLinearDispatch, type LinearDispatch, type LinearDispatchLayout } from "./linear-dispatch.js";
import { reductionStages, type ReductionStage } from "./reduction-stages.js";
import { webGpuKernel, type PhysicalKernel, type PipelineSelection, type UniformParameters } from "./kernel-catalogue.js";

export type { PipelineKey, PipelineSelection } from "./kernel-catalogue.js";

export function selectPipeline(kernel: PhysicalKernel, layout: LinearDispatchLayout): PipelineSelection {
  const selection = kernel[layout];
  if (selection === undefined) {
    throw new TabgradError("BACKEND_CAPABILITY_MISMATCH", "Windowed GPU kernels require their own immutable-offset layout.");
  }
  return selection;
}

export function pipelineSource(pipeline: PipelineSelection): string {
  return pipeline.source(pipeline.layout);
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
      let broadcast = false;
      if (elements !== 0) {
        for (const slot of computation.inputs) {
          if (tensorElementCount(program.values[slot]!.shape) !== elements) {
            broadcast = true;
            break;
          }
        }
      }
      if (!broadcast && !registration.densePacket) {
        const kernel = registration.direct;
        const dispatch = planLinearDispatch(elements, kernel.indexSpace, axis);
        return { path: "dense", dispatch, pipeline: selectPipeline(kernel, dispatch.layout), uniform: undefined };
      }
      const kernel = broadcast ? registration.projected : registration.direct;
      const fixedWidth = registration.densePacket ? kernel.indexSpace.elementsPerInvocation : undefined;
      const words = broadcast
        ? pointwiseParameters(registration.geometry.plan(computation.inputs.map(slot => program.values[slot]!.shape)), limits, fixedWidth)
        : new Uint32Array([0, elements, kernel.indexSpace.elementsPerInvocation]);
      const space = fixedWidth === undefined ? { ...kernel.indexSpace, elementsPerInvocation: words[2]! } : kernel.indexSpace;
      const dispatch = planLinearDispatch(elements, space, axis);
      return { path: "pointwise", dispatch, words, pipeline: selectPipeline(kernel, dispatch.layout) };
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

import { tensorElementCount } from "../tensor-shape.js";
import { TabgradError } from "../../shared/errors.js";
import { pointwiseBackingBytes, pointwiseReceivingOwners } from "./pointwise-derivative.js";
import type { DerivativePlan } from "./derivative-history.js";
import type { DerivativeCapturePolicy } from "./derivative-resources.js";

export interface DerivativeResourceDemand {
  readonly ownerSlots: number;
  readonly backingBytes: number;
}

/** Compose local proof-bearing demand with shared topology and policy floors. */
export function planDerivativeResources<Value>(
  plan: DerivativePlan<Value>, effects: number, captures: DerivativeCapturePolicy,
): DerivativeResourceDemand {
  let nodeElements = 0, edgeElements = 0, edges = 0;
  let localOwners = 0, receivingOwners = 0, excessBytes = 0;
  for (const node of plan.order) {
    const elements = tensorElementCount(node.shape);
    nodeElements += elements;
    for (let position = 0; position < node.inputs.length; position += 1) {
      const input = node.inputs[position]!;
      if (input === null || !plan.needed.has(input)) continue;
      const receiverElements = tensorElementCount(input.shape);
      const resources = node.recipe!.resources;
      const pointwise = node.recipe!.pointwise;
      edges += 1;
      edgeElements += receiverElements;
      localOwners += resources.localOwners;
      let backingBytes = resources.localBackings * receiverElements * 4;
      if (pointwise !== undefined) {
        const projection = pointwise.receivers[position]!;
        receivingOwners += pointwiseReceivingOwners(projection, captures);
        backingBytes = pointwiseBackingBytes(resources, projection, elements, receiverElements);
      }
      // The shared edge bound already pays for one receiver-sized contribution.
      excessBytes += Math.max(0, backingBytes - receiverElements * 4);
    }
  }
  const count = plan.order.length;
  if (count === 0) return { ownerSlots: 0, backingBytes: 0 };
  const combines = edges - count + 1;
  const outputElements = tensorElementCount(plan.order.at(-1)!.shape);
  // Current A<=4L, L<=2(M-1), C=L-M+1 and E<=M imply A+4C+8E<=20M.
  // The floor preserves those admissions; actual topology covers new arities.
  const ownerSlots = Math.max(count * 20, localOwners + combines * 4 + effects * 8) + receivingOwners;
  const backingBytes = Math.max(nodeElements * 20, edgeElements * 8 + outputElements * 4) + excessBytes;
  if (combines < 0 || !Number.isSafeInteger(effects) || effects < 0 || effects > count
    || !Number.isSafeInteger(ownerSlots) || !Number.isSafeInteger(backingBytes)) {
    throw new TabgradError("RESOURCE_EXHAUSTED", "Derivative resource demand exceeds safe accounting.");
  }
  return { ownerSlots, backingBytes };
}

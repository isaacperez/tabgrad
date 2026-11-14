import { receivingGeometry, type BroadcastGeometry } from "../../execution/broadcast-geometry.js";
import { TabgradError, throwCleanupFailures } from "../../shared/errors.js";
import type { DerivativeOperations, DerivativeRecipe } from "./derivative-history.js";
import { equalTensorShapes } from "../tensor-shape.js";

/** Bind immutable family geometry, leaving saved-value scheduling with history. */
export function pointwiseDerivative(local: DerivativeRecipe, geometry: BroadcastGeometry, aliasesIncoming = false): DerivativeRecipe {
  const receivers = Object.freeze(geometry.operands.map((_operand, position) => receivingGeometry(geometry, position)));
  return Object.freeze({
    consumesHistory: local.consumesHistory === true,
    pointwise: Object.freeze({ geometry, receivers, aliasesIncoming }),
    savedOperands: (position: number) => local.savedOperands(position),
    apply<Value, Gradient>(incoming: Gradient, saved: readonly Value[], shape: readonly number[],
      operations: DerivativeOperations<Value, Gradient>, position: number): Gradient {
      const shapeOf = operations.shape, receive = operations.receive;
      if (shapeOf === undefined || receive === undefined) throw new TabgradError("INVALID_SHAPE", "Pointwise derivatives require shaped receiving operations.");
      const projection = receivers[position];
      if (projection === undefined) throw new TabgradError("INVALID_SHAPE", "A pointwise derivative requires a captured receiver.");
      if (!equalTensorShapes(shape, projection.originalShape) || !equalTensorShapes(shapeOf(incoming), geometry.shape)) {
        throw new TabgradError("SHAPE_MISMATCH", "Pointwise history and incoming shapes must match their captured domains.");
      }
      const owned = new Set<Gradient>();
      let result!: Gradient, failures: unknown[] | undefined;
      try {
        const contribution = local.apply(incoming, saved, geometry.shape, operations, position);
        if (contribution === incoming) throw new TabgradError("INVALID_TENSOR", "A local derivative must return an owned contribution, not its borrowed seed.");
        owned.add(contribution);
        if (!equalTensorShapes(shapeOf(contribution), geometry.shape)) throw new TabgradError("SHAPE_MISMATCH", "A local pointwise derivative must have the complete output shape.");
        if (projection.exact) result = contribution;
        else {
          result = receive(contribution, projection);
          if (result === incoming) throw new TabgradError("INVALID_TENSOR", "Receiving reduction cannot return its borrowed seed.");
          owned.add(result);
          if (!equalTensorShapes(shapeOf(result), shape)) throw new TabgradError("SHAPE_MISMATCH", "A received contribution must have the complete input shape.");
          owned.delete(contribution);
          operations.close(contribution);
        }
        owned.delete(result);
      } catch (error) { failures = [error]; }
      for (const temporary of owned) {
        try { operations.close(temporary); }
        catch (error) { (failures ??= []).push(error); }
      }
      if (failures !== undefined) throwCleanupFailures(failures, "Pointwise derivative construction and cleanup failed.");
      return result;
    },
  });
}

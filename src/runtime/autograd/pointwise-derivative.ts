import { receivingGeometry, type BroadcastGeometry, type ReceivingGeometry } from "../../execution/broadcast-geometry.js";
import { TabgradError, throwCleanupFailures } from "../../shared/errors.js";
import type { DerivativeOperations, DerivativeRecipe } from "./derivative-history.js";
import { equalTensorShapes } from "../tensor-shape.js";
import { requireDerivativeResources, type DerivativeResources, type DerivativeCapturePolicy } from "./derivative-resources.js";
import { hasCanonicalDerivativeControls } from "./derivative-recipes.js";

/** Bind immutable family geometry, leaving saved-value scheduling with history. */
export function pointwiseDerivative(local: DerivativeRecipe, geometry: BroadcastGeometry, aliasesIncoming = false): DerivativeRecipe {
  return new PointwiseDerivative(local, geometry, aliasesIncoming);
}

/** One immutable binding, with shared methods and no per-edge resource records. */
class PointwiseDerivative implements DerivativeRecipe {
  readonly #local: DerivativeRecipe;
  readonly resources: DerivativeResources;
  readonly consumesHistory: boolean;
  readonly pointwise: NonNullable<DerivativeRecipe["pointwise"]>;

  constructor(local: DerivativeRecipe, geometry: BroadcastGeometry, aliasesIncoming: boolean) {
    this.resources = requireDerivativeResources(local, geometry.operands.length);
    if (aliasesIncoming && this.resources.localBackings !== 0) {
      throw new TabgradError("UNSUPPORTED_GRADIENT", "An incoming alias cannot declare local numerical backings.");
    }
    this.#local = local;
    this.consumesHistory = local.consumesHistory === true;
    const receivers = Object.freeze(geometry.operands.map((_operand, position) => receivingGeometry(geometry, position)));
    this.pointwise = Object.freeze({ geometry, receivers, aliasesIncoming });
    Object.freeze(this);
  }

  savedOperands(position: number): readonly number[] { return this.#local.savedOperands(position); }

  apply<Value, Gradient>(incoming: Gradient, saved: readonly Value[], shape: readonly number[],
      operations: DerivativeOperations<Value, Gradient>, position: number): Gradient {
    const shapeOf = operations.shape, receive = operations.receive;
    if (shapeOf === undefined || receive === undefined) throw new TabgradError("INVALID_SHAPE", "Pointwise derivatives require shaped receiving operations.");
    const { geometry, receivers } = this.pointwise;
    const projection = receivers[position];
    if (projection === undefined) throw new TabgradError("INVALID_SHAPE", "A pointwise derivative requires a captured receiver.");
    if (!equalTensorShapes(shape, projection.originalShape) || !equalTensorShapes(shapeOf(incoming), geometry.shape)) {
      throw new TabgradError("SHAPE_MISMATCH", "Pointwise history and incoming shapes must match their captured domains.");
    }
    const owned = new Set<Gradient>();
    let result!: Gradient, failures: unknown[] | undefined;
    try {
      const contribution = this.#local.apply(incoming, saved, geometry.shape, operations, position);
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
  }

  static hasCanonicalControls(recipe: DerivativeRecipe): boolean {
    return #local in recipe && Object.getPrototypeOf(recipe) === PointwiseDerivative.prototype
      && hasCanonicalDerivativeControls(recipe.#local);
  }
}

Object.freeze(PointwiseDerivative.prototype);

/** Factory provenance and exact local recipe identity, not asserted metadata. */
export function hasCanonicalPointwiseControls(recipe: DerivativeRecipe): boolean {
  return PointwiseDerivative.hasCanonicalControls(recipe);
}

/** Local products remain in the output domain until reception completes. */
export function pointwiseBackingBytes(
  resources: DerivativeResources, projection: ReceivingGeometry, outputElements: number, receiverElements: number,
): number {
  return resources.localBackings * outputElements * 4 + (projection.exact ? 0 : receiverElements * 4);
}

/** Reception and its optional shape restoration use ordinary capture costs. */
export function pointwiseReceivingOwners(projection: ReceivingGeometry, captures: DerivativeCapturePolicy): number {
  if (projection.exact) return 0;
  return captures.receivingOwners + (equalTensorShapes(projection.shape, projection.originalShape) ? 0 : captures.restorationOwners);
}

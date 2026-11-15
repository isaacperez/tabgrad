import { TabgradError } from "../../shared/errors.js";

/** Reviewed local construction bounds; copies use the contribution's domain. */
export class DerivativeResources {
  readonly #validated = true;

  constructor(
    readonly arity: number,
    readonly localOwners: number,
    readonly localBackings: number,
  ) {
    if (!Number.isSafeInteger(arity) || arity < 1
      || !Number.isSafeInteger(localOwners) || localOwners < 1
      || !Number.isSafeInteger(localBackings) || localBackings < 0) {
      throw new TabgradError("UNSUPPORTED_GRADIENT", "Derivative resource bounds must be safe nonnegative counts with positive arity and owners.");
    }
    Object.freeze(this);
  }

  static is(value: unknown): value is DerivativeResources {
    return typeof value === "object" && value !== null && #validated in value;
  }
}

/** Inspect passive own data without invoking a recipe-supplied cost accessor. */
export function requireDerivativeResources(recipe: object, arity: number): DerivativeResources {
  const property = Object.getOwnPropertyDescriptor(recipe, "resources");
  if (!Object.isFrozen(recipe) || property === undefined || !("value" in property)
    || !DerivativeResources.is(property.value) || property.value.arity !== arity) {
    throw new TabgradError("UNSUPPORTED_GRADIENT", "A derivative requires an immutable resource declaration matching its inputs.");
  }
  return property.value;
}

/** Ordinary runtime capture costs, supplied by their existing admission owner. */
export interface DerivativeCapturePolicy {
  readonly receivingOwners: number;
  readonly restorationOwners: number;
}

import type { DerivativeOperations, DerivativeRecipe } from "./derivative-history.js";
import { TabgradError } from "../../shared/errors.js";

/** Addition and contiguous views both pass incoming values in the input shape. */
export const IDENTITY_DERIVATIVE: DerivativeRecipe = Object.freeze({
  savedOperands: () => [],
  apply<Value, Gradient>(incoming: Gradient, _saved: readonly Value[], shape: readonly number[],
    operations: DerivativeOperations<Value, Gradient>): Gradient {
    return operations.view(incoming, shape);
  },
});

/** Add and copy pass the native incoming identity; a view creates a new identity. */
export const PASS_DERIVATIVE: DerivativeRecipe = Object.freeze({
  savedOperands: () => [],
  apply<Value, Gradient>(incoming: Gradient, _saved: readonly Value[], shape: readonly number[],
    operations: DerivativeOperations<Value, Gradient>): Gradient {
    return operations.pass?.(incoming, shape) ?? operations.view(incoming, shape);
  },
});

export const MUL_DERIVATIVE: DerivativeRecipe = Object.freeze({
  savedOperands: (position: number) => [1 - position],
  apply<Value, Gradient>(incoming: Gradient, saved: readonly Value[], _shape: readonly number[],
    operations: DerivativeOperations<Value, Gradient>): Gradient {
    if (saved.length !== 1) throw new TabgradError("CONSUMED_HISTORY", "Multiplication requires its saved operand.");
    const operand = operations.borrow(saved[0]!);
    try { return operations.mul(incoming, operand); }
    finally { operations.close(operand); }
  },
});

export const SUM_DERIVATIVE: DerivativeRecipe = Object.freeze({
  savedOperands: () => [],
  apply<Value, Gradient>(incoming: Gradient, _saved: readonly Value[], shape: readonly number[],
    operations: DerivativeOperations<Value, Gradient>): Gradient {
    return operations.expand(incoming, shape);
  },
});

/** A full copy keeps a connected old-destination edge with exact positive zeros. */
export const COPY_DERIVATIVE: DerivativeRecipe = Object.freeze({
  savedOperands: () => [],
  apply<Value, Gradient>(incoming: Gradient, _saved: readonly Value[], shape: readonly number[],
    operations: DerivativeOperations<Value, Gradient>, position: number): Gradient {
    return position === 0 ? operations.zeros(shape) : (operations.pass?.(incoming, shape) ?? operations.view(incoming, shape));
  },
});

/** Native whole-view rebasing consumes call state even without numerical saves. */
export const COPY_SLICES_DERIVATIVE: DerivativeRecipe = Object.freeze({
  ...COPY_DERIVATIVE,
  consumesHistory: true,
});

import type { DerivativeOperations, DerivativeRecipe } from "./derivative-history.js";
import { TabgradError, throwCleanupFailures } from "../../shared/errors.js";

/** History cannot retire a calculated value that its recipe never returned. */
function withBorrowedOperand<Value, Gradient>(saved: Value, operations: DerivativeOperations<Value, Gradient>,
  calculate: (operand: Gradient) => Gradient, message: string): Gradient {
  const operand = operations.borrow(saved);
  let result!: Gradient;
  let produced = false;
  let failures: unknown[] | undefined;
  try { result = calculate(operand); produced = true; }
  catch (error) { failures = [error]; }
  try { operations.close(operand); }
  catch (error) { (failures ??= []).push(error); }
  if (failures !== undefined) {
    if (produced) {
      try { operations.close(result); }
      catch (error) { failures.push(error); }
    }
    throwCleanupFailures(failures, message);
  }
  return result;
}

/** Contiguous views adapt incoming values to their input shape. */
export const IDENTITY_DERIVATIVE: DerivativeRecipe = Object.freeze({
  savedOperands: () => [],
  apply<Value, Gradient>(incoming: Gradient, _saved: readonly Value[], shape: readonly number[],
    operations: DerivativeOperations<Value, Gradient>): Gradient {
    return operations.view(incoming, shape);
  },
});

/** Local pointwise identity stays in the output domain; reception is separate. */
export const POINTWISE_PASS_DERIVATIVE: DerivativeRecipe = Object.freeze({
  savedOperands: () => [],
  apply<Value, Gradient>(incoming: Gradient, _saved: readonly Value[], shape: readonly number[],
    operations: DerivativeOperations<Value, Gradient>): Gradient {
    if (operations.pass === undefined) throw new TabgradError("UNSUPPORTED_GRADIENT", "Pointwise identity requires an owned incoming alias.");
    return operations.pass(incoming, shape);
  },
});

export const MUL_DERIVATIVE: DerivativeRecipe = Object.freeze({
  savedOperands: (position: number) => [1 - position],
  apply<Value, Gradient>(incoming: Gradient, saved: readonly Value[], _shape: readonly number[],
    operations: DerivativeOperations<Value, Gradient>): Gradient {
    if (saved.length !== 1) throw new TabgradError("CONSUMED_HISTORY", "Multiplication requires its saved operand.");
    return withBorrowedOperand(saved[0]!, operations, operand => operations.mul(incoming, operand),
      "Multiplication derivative construction and cleanup failed.");
  },
});

/** Ordinary VJPs use captured orientations, with no transposed payload owner. */
export const MATMUL_DERIVATIVE: DerivativeRecipe = Object.freeze({
  savedOperands: (position: number) => [1 - position],
  apply<Value, Gradient>(incoming: Gradient, saved: readonly Value[], _shape: readonly number[],
    operations: DerivativeOperations<Value, Gradient>, position: number): Gradient {
    if (saved.length !== 1) throw new TabgradError("CONSUMED_HISTORY", "Matrix multiplication requires its saved operand.");
    return withBorrowedOperand(saved[0]!, operations, operand => position === 0
      ? operations.matmul(incoming, operand, "right") : operations.matmul(operand, incoming, "left"),
    "Matrix derivative construction and cleanup failed.");
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
  apply<Value, Gradient>(incoming: Gradient, _saved: readonly Value[], shape: readonly number[],
    operations: DerivativeOperations<Value, Gradient>, position: number): Gradient {
    return position === 0 ? operations.zeros(shape) : operations.clone(incoming, shape);
  },
});


/** Re-resolving a modified view creates the native rebased base contribution. */
export const REBASED_VIEW_DERIVATIVE: DerivativeRecipe = Object.freeze({
  savedOperands: () => [],
  apply<Value, Gradient>(incoming: Gradient, _saved: readonly Value[], shape: readonly number[],
    operations: DerivativeOperations<Value, Gradient>): Gradient {
    return operations.rebase(incoming, shape);
  },
});

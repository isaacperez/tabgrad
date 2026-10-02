import { TabgradError } from "../../shared/errors.js";

/** A canonical operation supplies its saved-operand selection and local VJP. */
export interface DerivativeRecipe {
  savedOperands(position: number): readonly number[];
  apply<Value, Gradient>(
    incoming: Gradient, saved: readonly Value[], shape: readonly number[],
    operations: DerivativeOperations<Value, Gradient>,
  ): Gradient;
}

/** History edges retain derivative identities, never the forward producer graph. */
export class DerivativeNode<Value> {
  references = 1;
  consumed = false;
  constructor(
    readonly shape: readonly number[],
    readonly recipe: DerivativeRecipe | null,
    public inputs: readonly (DerivativeNode<Value> | null)[],
    public saved: readonly (readonly Value[])[],
  ) {}
}

/** Numerical and handle ownership stays with the runtime's ordinary admission path. */
export interface DerivativeOperations<Value, Gradient> {
  borrow(value: Value): Gradient;
  add(left: Gradient, right: Gradient): Gradient;
  mul(left: Gradient, right: Gradient): Gradient;
  view(value: Gradient, shape: readonly number[]): Gradient;
  expand(value: Gradient, shape: readonly number[]): Gradient;
  close(value: Gradient): void;
}

interface TraversalFrame<Value> {
  readonly node: DerivativeNode<Value>;
  nextInput: number;
}

export interface DerivativePlan<Value> {
  readonly order: readonly DerivativeNode<Value>[];
  readonly needed: ReadonlySet<DerivativeNode<Value>>;
  readonly requested: readonly DerivativeNode<Value>[];
}

function releaseTemporary<Value, Gradient>(
  gradient: Gradient, owned: Set<Gradient>, operations: DerivativeOperations<Value, Gradient>,
): void {
  if (owned.delete(gradient)) operations.close(gradient);
}

/** Own dynamic recipes and logical saved pins independently of payload storage. */
export class DerivativeHistory<Value> {
  readonly #nodes = new Set<DerivativeNode<Value>>();
  #savedValues = 0;

  constructor(
    private readonly retainValue: (value: Value) => void,
    private readonly releaseValue: (value: Value) => void,
  ) {}

  leaf(shape: readonly number[]): DerivativeNode<Value> {
    return this.#create(shape, null, [], []);
  }

  record(
    shape: readonly number[], recipe: DerivativeRecipe,
    inputs: readonly (DerivativeNode<Value> | null)[], values: readonly Value[],
  ): DerivativeNode<Value> | null {
    if (inputs.every((input) => input === null)) return null;
    const saved = inputs.map((input, position) => {
      const operands = input === null ? [] : recipe.savedOperands(position);
      return operands.map((operand) => values[operand]!);
    });
    for (const input of inputs) if (input !== null) input.references += 1;
    for (const operands of saved) {
      for (const value of operands) {
        this.retainValue(value);
        this.#savedValues += 1;
      }
    }
    return this.#create(shape, recipe, inputs, saved.some((operands) => operands.length !== 0) ? saved : []);
  }

  #create(
    shape: readonly number[], recipe: DerivativeRecipe | null,
    inputs: readonly (DerivativeNode<Value> | null)[], saved: readonly (readonly Value[])[],
  ): DerivativeNode<Value> {
    const node = new DerivativeNode(shape, recipe, inputs, saved);
    this.#nodes.add(node);
    return node;
  }

  release(node: DerivativeNode<Value>): void {
    const pending = [node];
    while (pending.length !== 0) {
      const current = pending.pop()!;
      current.references -= 1;
      if (current.references !== 0) continue;
      this.#nodes.delete(current);
      this.#releaseSaved(current);
      for (const input of current.inputs) if (input !== null) pending.push(input);
      current.inputs = [];
    }
  }

  #releaseSaved(node: DerivativeNode<Value>): void {
    for (const operands of node.saved) {
      for (const value of operands) {
        this.releaseValue(value);
        this.#savedValues -= 1;
      }
    }
    node.saved = [];
  }

  /** Validate the entire selected ancestry before numerical admission or consumption. */
  plan(output: DerivativeNode<Value>, requested: readonly DerivativeNode<Value>[]): DerivativePlan<Value> {
    const targets = new Set(requested);
    const visited = new Set<DerivativeNode<Value>>();
    const needed = new Set<DerivativeNode<Value>>();
    const order: DerivativeNode<Value>[] = [];
    const frames: TraversalFrame<Value>[] = [{ node: output, nextInput: 0 }];
    while (frames.length !== 0) {
      const frame = frames[frames.length - 1]!;
      if (frame.nextInput < frame.node.inputs.length) {
        const input = frame.node.inputs[frame.nextInput++]!;
        if (input !== null && !visited.has(input)) frames.push({ node: input, nextInput: 0 });
        continue;
      }
      const node = frame.node;
      if (targets.has(node) || node.inputs.some((input) => input !== null && needed.has(input))) {
        needed.add(node);
        order.push(node);
      }
      visited.add(node);
      frames.pop();
    }
    if (requested.some((node) => !visited.has(node))) {
      throw new TabgradError("UNUSED_INPUT", "A requested input was not used to compute the output.");
    }
    for (const node of order) {
      if (node.consumed && node.inputs.some((input) => input !== null && needed.has(input))) {
        throw new TabgradError("CONSUMED_HISTORY", "Saved derivative values have already been consumed.");
      }
    }
    return { order, needed, requested };
  }

  /** Each contribution is an ordinary untracked tensor; repeated requests own distinct handles. */
  execute<Gradient>(
    plan: DerivativePlan<Value>, seed: Gradient, operations: DerivativeOperations<Value, Gradient>,
  ): Gradient[] {
    const gradients = new Map<DerivativeNode<Value>, Gradient>();
    const temporaries = new Set<Gradient>();
    const requested = new Set(plan.requested);
    const results: Gradient[] = [];
    const consumed: DerivativeNode<Value>[] = [];
    gradients.set(plan.order[plan.order.length - 1]!, seed);
    try {
      for (let index = plan.order.length - 1; index >= 0; index -= 1) {
        const node = plan.order[index]!;
        const incoming = gradients.get(node)!;
        let traversed = false;
        for (let position = 0; position < node.inputs.length; position += 1) {
          const input = node.inputs[position]!;
          if (input === null || !plan.needed.has(input)) continue;
          traversed = true;
          let contribution = node.recipe!.apply(incoming, node.saved[position] ?? [], input.shape, operations);
          temporaries.add(contribution);
          const previous = gradients.get(input);
          if (previous !== undefined) {
            const combined = operations.add(previous, contribution);
            temporaries.add(combined);
            releaseTemporary(previous, temporaries, operations);
            releaseTemporary(contribution, temporaries, operations);
            contribution = combined;
          }
          gradients.set(input, contribution);
        }
        if (traversed && node.saved.length !== 0) consumed.push(node);
        if (!requested.has(node)) {
          gradients.delete(node);
          releaseTemporary(incoming, temporaries, operations);
        }
      }
      for (const node of plan.requested) results.push(operations.view(gradients.get(node)!, node.shape));
      for (const node of consumed) {
        this.#releaseSaved(node);
        node.consumed = true;
      }
      return results;
    } catch (error) {
      for (const result of results) operations.close(result);
      throw error;
    } finally {
      for (const temporary of temporaries) operations.close(temporary);
    }
  }

  diagnostics(): { readonly liveDerivativeNodes: number; readonly liveSavedValues: number } {
    return { liveDerivativeNodes: this.#nodes.size, liveSavedValues: this.#savedValues };
  }
}

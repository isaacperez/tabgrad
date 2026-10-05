import { WriterOutcome, captureWriterOutcomes, retainWriterOutcomes, releaseWriterOutcomes } from "../writer-outcome.js";
import { TabgradError, throwCleanupFailures } from "../../shared/errors.js";

/** A canonical operation supplies its saved-operand selection and local VJP. */
export interface DerivativeRecipe {
  readonly consumesHistory?: boolean;
  savedOperands(position: number): readonly number[];
  apply<Value, Gradient>(
    incoming: Gradient, saved: readonly Value[], shape: readonly number[],
    operations: DerivativeOperations<Value, Gradient>, position: number,
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
    readonly outcomes: readonly WriterOutcome[] = [],
    readonly sequence: number = 0,
  ) {}
}

/** Highest construction priority among ready nodes, never among blocked ancestors. */
class ReadyDerivativeNodes<Value> {
  readonly #heap: DerivativeNode<Value>[] = [];

  push(node: DerivativeNode<Value>): void {
    let index = this.#heap.length;
    this.#heap.push(node);
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this.#heap[parent]!.sequence >= node.sequence) break;
      this.#heap[index] = this.#heap[parent]!;
      index = parent;
    }
    this.#heap[index] = node;
  }

  pop(): DerivativeNode<Value> | undefined {
    const first = this.#heap[0];
    const last = this.#heap.pop();
    if (this.#heap.length !== 0) {
      let index = 0;
      while (index * 2 + 1 < this.#heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.#heap.length && this.#heap[child + 1]!.sequence > this.#heap[child]!.sequence) child += 1;
        if (last!.sequence >= this.#heap[child]!.sequence) break;
        this.#heap[index] = this.#heap[child]!;
        index = child;
      }
      this.#heap[index] = last!;
    }
    return first;
  }
}

/** Numerical and handle ownership stays with the runtime's ordinary admission path. */
export interface DerivativeOperations<Value, Gradient> {
  borrow(value: Value): Gradient;
  add(left: Gradient, right: Gradient): Gradient;
  mul(left: Gradient, right: Gradient): Gradient;
  view(value: Gradient, shape: readonly number[]): Gradient;
  expand(value: Gradient, shape: readonly number[]): Gradient;
  zeros(shape: readonly number[]): Gradient;
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
  readonly outcomes: readonly (readonly WriterOutcome[])[];
}

function releaseTemporary<Value, Gradient>(
  gradient: Gradient, owned: Set<Gradient>, operations: DerivativeOperations<Value, Gradient>,
): void {
  if (owned.delete(gradient)) operations.close(gradient);
}

/** Attempt independent handle retirement without losing an earlier failure. */
function releaseGradients<Value, Gradient>(
  gradients: Iterable<Gradient>, operations: DerivativeOperations<Value, Gradient>,
  failures: unknown[] | undefined,
): unknown[] | undefined {
  for (const gradient of gradients) {
    try { operations.close(gradient); }
    catch (error) { (failures ??= []).push(error); }
  }
  return failures;
}

/** Own dynamic recipes and logical saved pins independently of payload storage. */
export class DerivativeHistory<Value> {
  readonly #nodes = new Set<DerivativeNode<Value>>();
  #savedValues = 0;
  #references = 0;
  #sequence = 0;
  get references(): number { return this.#references; }

  constructor(
    private readonly retainValue: (value: Value) => void,
    private readonly releaseValue: (value: Value) => void,
    private readonly validateValue: (value: Value) => void = () => {},
    private readonly valueOutcomes: (value: Value) => readonly WriterOutcome[] = () => [],
  ) {}

  leaf(shape: readonly number[]): DerivativeNode<Value> {
    return this.#create(shape, null, [], []);
  }

  record(
    shape: readonly number[], recipe: DerivativeRecipe,
    inputs: readonly (DerivativeNode<Value> | null)[], values: readonly Value[],
    outcomes: readonly WriterOutcome[] = [],
  ): DerivativeNode<Value> {
    // Admission decides advertised tracking. An active operation on a tracked
    // no-grad view has a real recipe even when all its input edges are absent.
    const saved = inputs.map((input, position) => {
      const operands = input === null ? [] : recipe.savedOperands(position);
      return operands.map((operand) => values[operand]!);
    });
    for (const input of inputs) if (input !== null) { input.references += 1; this.#references += 1; }
    for (const operands of saved) {
      for (const value of operands) {
        this.retainValue(value);
        this.#savedValues += 1;
      }
    }
    return this.#create(shape, recipe, inputs, saved.some((operands) => operands.length !== 0) ? saved : [],
      captureWriterOutcomes([outcomes, ...values.map(this.valueOutcomes)]));
  }

  #create(
    shape: readonly number[], recipe: DerivativeRecipe | null,
    inputs: readonly (DerivativeNode<Value> | null)[], saved: readonly (readonly Value[])[],
    outcomes: readonly WriterOutcome[] = [],
  ): DerivativeNode<Value> {
    const node = new DerivativeNode(shape, recipe, inputs, saved, outcomes, this.#sequence++);
    retainWriterOutcomes(outcomes);
    this.#nodes.add(node);
    this.#references += 1;
    return node;
  }

  release(node: DerivativeNode<Value>): void {
    const pending = [node];
    let failures: unknown[] | undefined;
    while (pending.length !== 0) {
      const current = pending.pop()!;
      current.references -= 1;
      this.#references -= 1;
      if (current.references !== 0) continue;
      this.#nodes.delete(current);
      releaseWriterOutcomes(current.outcomes);
      try { this.#releaseSaved(current); }
      catch (error) { (failures ??= []).push(error); }
      for (const input of current.inputs) if (input !== null) pending.push(input);
      current.inputs = [];
    }
    throwCleanupFailures(failures, "Derivative history cleanup failed.");
  }

  #releaseSaved(node: DerivativeNode<Value>): void {
    const saved = node.saved;
    node.saved = [];
    let failures: unknown[] | undefined;
    for (const operands of saved) {
      for (const value of operands) {
        this.#savedValues -= 1;
        try { this.releaseValue(value); }
        catch (error) { (failures ??= []).push(error); }
      }
    }
    throwCleanupFailures(failures, "Saved derivative value cleanup failed.");
  }

  /** Validate connectivity and select ancestry without executing or checking saved state. */
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
    return { order, needed, requested, outcomes: order
      .filter((node) => node.inputs.some((input) => input !== null && needed.has(input)))
      .map((node) => node.outcomes) };
  }

  /** Each contribution is an ordinary untracked tensor; repeated requests own distinct handles. */
  execute<Gradient>(
    plan: DerivativePlan<Value>, seed: Gradient, operations: DerivativeOperations<Value, Gradient>,
  ): Gradient[] {
    const gradients = new Map<DerivativeNode<Value>, Gradient>();
    const temporaries = new Set<Gradient>();
    const requested = new Set(plan.requested);
    const results: Gradient[] = [];
    const pending = new Map<DerivativeNode<Value>, number>();
    const ready = new ReadyDerivativeNodes<Value>();
    for (const node of plan.order) {
      for (const input of node.inputs) {
        if (input !== null && plan.needed.has(input)) pending.set(input, (pending.get(input) ?? 0) + 1);
      }
    }
    const output = plan.order[plan.order.length - 1]!;
    ready.push(output);
    let consumptionFailures: unknown[] | undefined;
    let failures: unknown[] | undefined;
    gradients.set(output, seed);
    try {
      let node: DerivativeNode<Value> | undefined;
      while ((node = ready.pop()) !== undefined) {
        const incoming = gradients.get(node)!;
        const traversed = node.inputs.some((input) => input !== null && plan.needed.has(input));
        if (traversed) {
          if (node.consumed) throw new TabgradError("CONSUMED_HISTORY", "Saved derivative values have already been consumed.");
          // Native checks every required save of this executing recipe, including
          // saves whose numerical input contribution is pruned by the selection.
          for (const operands of node.saved) for (const value of operands) this.validateValue(value);
        }
        for (let position = 0; position < node.inputs.length; position += 1) {
          const input = node.inputs[position]!;
          if (input === null || !plan.needed.has(input)) continue;
          let contribution = node.recipe!.apply(incoming, node.saved[position] ?? [], input.shape, operations, position);
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
          const remaining = pending.get(input)! - 1;
          pending.set(input, remaining);
          if (remaining === 0) ready.push(input);
        }
        if (traversed && (node.saved.length !== 0 || node.recipe?.consumesHistory === true)) {
          node.consumed = true;
          try { this.#releaseSaved(node); }
          catch (error) { (consumptionFailures ??= []).push(error); }
        }
        if (!requested.has(node)) {
          gradients.delete(node);
          releaseTemporary(incoming, temporaries, operations);
        }
      }
      for (const node of plan.requested) results.push(operations.view(gradients.get(node)!, node.shape));
    } catch (error) {
      failures = [error];
    }
    if (consumptionFailures !== undefined) failures = [...(failures ?? []), ...consumptionFailures];
    failures = releaseGradients(temporaries, operations, failures);
    if (failures !== undefined) failures = releaseGradients(results, operations, failures);
    throwCleanupFailures(failures, "Derivative construction or cleanup failed.");
    return results;
  }

  diagnostics(): { readonly liveDerivativeNodes: number; readonly liveSavedValues: number } {
    return { liveDerivativeNodes: this.#nodes.size, liveSavedValues: this.#savedValues };
  }
}

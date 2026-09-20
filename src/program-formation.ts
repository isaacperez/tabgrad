import type { ProgramBinding, ResidentAllocation } from "./cpu-backend.js";
import {
  ExecutableProgram,
  type LoweredAddFloat32,
  type ProgramProvenance,
  type ProgramSlot,
  type ProgramValue,
} from "./executable-program.js";

/** The admitted, acyclic value graph read by formation; no ownership is transferred. */
export interface FormationValue<Value> {
  readonly shape: readonly [number];
  readonly dtype: "float32";
  readonly device: "cpu";
  readonly layout: "contiguous";
  readonly provenance: ProgramProvenance;
  readonly producer: {
    readonly definition: { readonly loweredKind: "add-f32" };
    readonly inputs: readonly [Value, Value];
    readonly provenance: ProgramProvenance;
  } | null;
}

export type Materialization =
  | { readonly kind: "host"; readonly data: Float32Array }
  | { readonly kind: "resident"; readonly allocation: ResidentAllocation };

/** Invocation associations stay separate from immutable, payload-free structure. */
export interface FormedProgram<Value> {
  readonly program: ExecutableProgram;
  readonly bindings: ReadonlyMap<ProgramSlot, ProgramBinding>;
  readonly valuesBySlot: ReadonlyMap<ProgramSlot, Value>;
  readonly newlyComputed: readonly Value[];
}

interface FormationFrame<Value extends FormationValue<Value>> {
  readonly value: Value;
  readonly producer: FormationValue<Value>["producer"];
  readonly materialization: Materialization | undefined;
  nextInput: number;
}

function formationFrame<Value extends FormationValue<Value>>(
  value: Value,
  materialization: Materialization | undefined,
): FormationFrame<Value> {
  return {
    value,
    producer: materialization?.kind === "resident" ? null : value.producer,
    materialization,
    nextInput: 0,
  };
}

/**
 * Form one selected dependency closure without execution or state mutation.
 * Inputs must be an admitted DAG, stable for this synchronous call. Resident
 * values cut traversal. A frame advances each input once; completed slots
 * deduplicate shared ancestry while preserving input-order postorder.
 * Work and storage are linear in selected values and edges, not session history.
 */
export function formExecutableProgram<Value extends FormationValue<Value>>(
  root: Value,
  materializations: { get(value: Value): Materialization | undefined },
): FormedProgram<Value> {
  const slots = new Map<Value, ProgramSlot>();
  const values: ProgramValue[] = [];
  const computations: LoweredAddFloat32[] = [];
  const bindings = new Map<ProgramSlot, ProgramBinding>();
  const valuesBySlot = new Map<ProgramSlot, Value>();
  const newlyComputed: Value[] = [];
  const frames = [formationFrame(root, materializations.get(root))];

  while (frames.length !== 0) {
    const frame = frames[frames.length - 1]!;
    const { value, producer, materialization } = frame;
    if (producer !== null && frame.nextInput < producer.inputs.length) {
      const input = producer.inputs[frame.nextInput++]!;
      if (!slots.has(input)) {
        frames.push(formationFrame(input, materializations.get(input)));
      }
      continue;
    }

    // Every input has completed before its consumer receives a slot.
    const slot = values.length;
    slots.set(value, slot);
    valuesBySlot.set(slot, value);
    values.push({
      slot,
      dtype: value.dtype,
      device: value.device,
      layout: value.layout,
      shape: value.shape,
      source: producer === null ? "binding" : "computed",
      provenance: value.provenance,
    });
    if (materialization?.kind === "host") {
      bindings.set(slot, { hostData: materialization.data });
    } else if (materialization?.kind === "resident") {
      bindings.set(slot, { resident: materialization.allocation });
    }
    if (producer !== null) {
      computations.push({
        kind: producer.definition.loweredKind,
        left: slots.get(producer.inputs[0])!,
        right: slots.get(producer.inputs[1])!,
        output: slot,
        provenance: producer.provenance,
      });
      newlyComputed.push(value);
    }
    frames.pop();
  }

  return {
    program: new ExecutableProgram(values, computations, slots.get(root)!),
    bindings,
    valuesBySlot,
    newlyComputed,
  };
}

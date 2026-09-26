export type ProgramSlot = number;

export interface ProgramProvenance {
  readonly operation: string;
  readonly source: string;
}

export interface ProgramValue {
  readonly slot: ProgramSlot;
  /** Canonical virtual storage slot; contiguous aliases cover its entire payload. */
  readonly storageSlot: ProgramSlot;
  readonly dtype: "float32";
  readonly device: "cpu";
  readonly layout: "contiguous";
  readonly shape: readonly number[];
  readonly source: "binding" | "computed" | "alias";
  readonly provenance: ProgramProvenance;
}

export interface LoweredComputation {
  readonly kind: "add-f32" | "mul-f32" | "sum-f32";
  /** Ordered operand occurrences, including repeats; arity belongs to the operation. */
  readonly inputs: readonly ProgramSlot[];
  readonly output: ProgramSlot;
  readonly provenance: ProgramProvenance;
}

export class ExecutableProgram {
  readonly formatVersion = 3;
  readonly domain = "webassembly-cpu";
  readonly values: readonly ProgramValue[];
  readonly computations: readonly LoweredComputation[];
  /** Input occurrences per slot, independent of scheduling or invocation owners. */
  readonly inputUseCounts: readonly number[];
  /** Physical input occurrences aggregated across aliases of each storage slot. */
  readonly storageUseCounts: readonly number[];
  readonly result: ProgramSlot;

  constructor(
    values: readonly ProgramValue[],
    computations: readonly LoweredComputation[],
    result: ProgramSlot,
  ) {
    this.values = Object.freeze(values.map((value) => Object.freeze({
      ...value,
      shape: Object.freeze([...value.shape]),
      provenance: Object.freeze({ ...value.provenance }),
    })));
    const inputUseCounts = new Array<number>(values.length).fill(0);
    const storageUseCounts = new Array<number>(values.length).fill(0);
    this.computations = Object.freeze(
      computations.map((computation) => {
        for (const input of computation.inputs) {
          inputUseCounts[input]! += 1;
          storageUseCounts[values[input]!.storageSlot]! += 1;
        }
        return Object.freeze({
          ...computation,
          inputs: Object.freeze([...computation.inputs]),
          provenance: Object.freeze({ ...computation.provenance }),
        });
      }),
    );
    this.inputUseCounts = Object.freeze(inputUseCounts);
    this.storageUseCounts = Object.freeze(storageUseCounts);
    this.result = result;
    Object.freeze(this);
  }
}

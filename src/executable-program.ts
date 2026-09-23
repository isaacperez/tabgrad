export type ProgramSlot = number;

export interface ProgramProvenance {
  readonly operation: string;
  readonly source: string;
}

export interface ProgramValue {
  readonly slot: ProgramSlot;
  readonly dtype: "float32";
  readonly device: "cpu";
  readonly layout: "contiguous";
  readonly shape: readonly number[];
  readonly source: "binding" | "computed";
  readonly provenance: ProgramProvenance;
}

export interface LoweredAddFloat32 {
  readonly kind: "add-f32";
  readonly left: ProgramSlot;
  readonly right: ProgramSlot;
  readonly output: ProgramSlot;
  readonly provenance: ProgramProvenance;
}

export class ExecutableProgram {
  readonly formatVersion = 1;
  readonly domain = "webassembly-cpu";
  readonly values: readonly ProgramValue[];
  readonly computations: readonly LoweredAddFloat32[];
  /** Input occurrences per slot, independent of scheduling or invocation owners. */
  readonly inputUseCounts: readonly number[];
  readonly result: ProgramSlot;

  constructor(
    values: readonly ProgramValue[],
    computations: readonly LoweredAddFloat32[],
    result: ProgramSlot,
  ) {
    this.values = Object.freeze(values.map((value) => Object.freeze({
      ...value,
      shape: Object.freeze([...value.shape]),
      provenance: Object.freeze({ ...value.provenance }),
    })));
    const inputUseCounts = new Array<number>(values.length).fill(0);
    this.computations = Object.freeze(
      computations.map((computation) => {
        inputUseCounts[computation.left]! += 1;
        inputUseCounts[computation.right]! += 1;
        return Object.freeze({
          ...computation,
          provenance: Object.freeze({ ...computation.provenance }),
        });
      }),
    );
    this.inputUseCounts = Object.freeze(inputUseCounts);
    this.result = result;
    Object.freeze(this);
  }
}

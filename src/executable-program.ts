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
  readonly shape: readonly [number];
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
  readonly result: ProgramSlot;

  constructor(
    values: readonly ProgramValue[],
    computations: readonly LoweredAddFloat32[],
    result: ProgramSlot,
  ) {
    this.values = Object.freeze(values.map((value) => Object.freeze({
      ...value,
      shape: Object.freeze([...value.shape]) as readonly [number],
      provenance: Object.freeze({ ...value.provenance }),
    })));
    this.computations = Object.freeze(
      computations.map((computation) => Object.freeze({
        ...computation,
        provenance: Object.freeze({ ...computation.provenance }),
      })),
    );
    this.result = result;
    Object.freeze(this);
  }
}

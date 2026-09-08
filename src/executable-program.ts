export type ProgramSlot = number;

export interface ProgramValue {
  readonly slot: ProgramSlot;
  readonly dtype: "float32";
  readonly device: "cpu";
  readonly layout: "contiguous";
  readonly shape: readonly [number];
  readonly source: "binding" | "computed";
}

export interface LoweredAddFloat32 {
  readonly kind: "add-f32";
  readonly left: ProgramSlot;
  readonly right: ProgramSlot;
  readonly output: ProgramSlot;
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
    })));
    this.computations = Object.freeze(
      computations.map((computation) => Object.freeze({ ...computation })),
    );
    this.result = result;
    Object.freeze(this);
  }
}

import type { TensorDevice } from "./backend.js";
import { assertMatrixFlags, matrixGeometry } from "./matrix-geometry.js";

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
  readonly device: TensorDevice;
  readonly layout: "contiguous";
  readonly shape: readonly number[];
  readonly source: "binding" | "computed" | "alias";
  readonly provenance: ProgramProvenance;
}

export interface LoweredComputation {
  readonly kind: "add-f32" | "add-alpha-f32" | "mul-f32" | "sum-f32" | "expand-f32" | "matmul-f32";
  /** Captured binary32 coefficient; present only for add-alpha-f32. */
  readonly alphaBits?: number;
  /** Required for matmul-f32, absent for all other computations. */
  readonly matrixFlags?: number;
  /** Ordered operand occurrences, including repeats; arity belongs to the operation. */
  readonly inputs: readonly ProgramSlot[];
  readonly output: ProgramSlot;
  readonly provenance: ProgramProvenance;
}

/** Validate captured metadata at semantic creation and program reconstruction. */
export function assertComputationCoefficient(kind: LoweredComputation["kind"], alphaBits: number | undefined): void {
  if (kind === "add-alpha-f32") {
    if (!Number.isInteger(alphaBits) || alphaBits! < 0 || alphaBits! > 0xffff_ffff) {
      throw new TypeError("Coefficient addition requires captured binary32 bits.");
    }
  } else if (alphaBits !== undefined) {
    throw new TypeError("This operation has no coefficient.");
  }
}

export class ExecutableProgram {
  readonly formatVersion = 7;
  readonly domain: "webassembly-cpu" | "webgpu";
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
    this.domain = values[result]?.device === "webgpu" ? "webgpu" : "webassembly-cpu";
    this.values = Object.freeze(values.map((value) => Object.freeze({
      ...value,
      shape: Object.freeze([...value.shape]),
      provenance: Object.freeze({ ...value.provenance }),
    })));
    const inputUseCounts = new Array<number>(values.length).fill(0);
    const storageUseCounts = new Array<number>(values.length).fill(0);
    this.computations = Object.freeze(
      computations.map((computation) => {
        const captured = { ...computation };
        assertComputationCoefficient(captured.kind, captured.alphaBits);
        assertMatrixFlags(captured.kind, captured.matrixFlags);
        captured.inputs = Object.freeze([...captured.inputs]);
        captured.provenance = Object.freeze({ ...captured.provenance });
        if (captured.kind === "matmul-f32") {
          const left = this.values[captured.inputs[0]!];
          const right = this.values[captured.inputs[1]!];
          const output = this.values[captured.output];
          if (captured.inputs.length !== 2 || left === undefined || right === undefined || output === undefined) {
            throw new TypeError("Matrix multiplication requires two existing inputs and an output.");
          }
          const geometry = matrixGeometry(left.shape, right.shape, captured.matrixFlags!);
          if (output.shape.length !== 2 || output.shape[0] !== geometry.rows || output.shape[1] !== geometry.columns
            || left.device !== right.device || left.device !== output.device) {
            throw new TypeError("Matrix output shape and device must match its captured inputs.");
          }
        }
        for (const input of captured.inputs) {
          inputUseCounts[input]! += 1;
          storageUseCounts[values[input]!.storageSlot]! += 1;
        }
        return Object.freeze(captured);
      }),
    );
    this.inputUseCounts = Object.freeze(inputUseCounts);
    this.storageUseCounts = Object.freeze(storageUseCounts);
    this.result = result;
    Object.freeze(this);
  }
}

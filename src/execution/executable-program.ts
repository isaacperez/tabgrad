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

function copyProgramValue(value: ProgramValue): ProgramValue {
  const captured = { ...value };
  captured.shape = Object.freeze([...captured.shape]);
  captured.provenance = Object.freeze({ ...captured.provenance });
  return Object.freeze(captured);
}

function matrixValueElements(value: ProgramValue, counts: Map<ProgramSlot, number>): number {
  const known = counts.get(value.slot);
  if (known !== undefined) return known;
  if (value.shape.some(dimension => !Number.isSafeInteger(dimension) || dimension < 0)) {
    throw new TypeError("Matrix storage requires nonnegative safe dimensions.");
  }
  const count = value.shape.includes(0) ? 0 : value.shape.reduce((size, dimension) => size * dimension, 1);
  if (!Number.isSafeInteger(count)) throw new TypeError("Matrix storage exceeds safe element arithmetic.");
  counts.set(value.slot, count);
  return count;
}

function requireMatrixValue(slot: ProgramSlot, values: readonly ProgramValue[], counts: Map<ProgramSlot, number>): ProgramValue {
  const value = values[slot];
  if (!Number.isSafeInteger(slot) || slot < 0 || value === undefined || value.slot !== slot
    || value.dtype !== "float32" || value.layout !== "contiguous"
    || (value.device !== "cpu" && value.device !== "webgpu")
    || !Number.isSafeInteger(value.storageSlot) || value.storageSlot < 0
    || (value.source !== "binding" && value.source !== "computed" && value.source !== "alias")) {
    throw new TypeError("Matrix values require valid slots and float32 contiguous metadata.");
  }
  const storage = values[value.storageSlot];
  if (storage === undefined || storage.slot !== value.storageSlot || storage.storageSlot !== storage.slot
    || (storage.source !== "binding" && storage.source !== "computed")
    || storage.dtype !== value.dtype || storage.device !== value.device || storage.layout !== value.layout
    || (value.source === "alias" ? value.storageSlot === slot : value.storageSlot !== slot)
    || matrixValueElements(value, counts) !== matrixValueElements(storage, counts)) {
    throw new TypeError("Matrix aliases must cover their canonical storage exactly.");
  }
  return value;
}

function assertMatrixComputation(values: readonly ProgramValue[], computation: LoweredComputation,
  result: ProgramSlot, counts: Map<ProgramSlot, number>): void {
  if (computation.inputs.length !== 2) throw new TypeError("Matrix multiplication requires two inputs.");
  const left = requireMatrixValue(computation.inputs[0]!, values, counts);
  const right = requireMatrixValue(computation.inputs[1]!, values, counts);
  const output = requireMatrixValue(computation.output, values, counts);
  const selected = requireMatrixValue(result, values, counts);
  const geometry = matrixGeometry(left.shape, right.shape, computation.matrixFlags!);
  if (output.source !== "computed" || output.storageSlot !== output.slot
    || output.storageSlot === left.storageSlot || output.storageSlot === right.storageSlot
    || !Number.isSafeInteger(geometry.outputElements) || output.shape.length !== 2
    || output.shape[0] !== geometry.rows || output.shape[1] !== geometry.columns
    || left.device !== right.device || left.device !== output.device || output.device !== selected.device) {
    throw new TypeError("Matrix output must own distinct storage with the captured shape and device.");
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
    this.values = Object.freeze(values.map(copyProgramValue));
    this.domain = this.values[result]?.device === "webgpu" ? "webgpu" : "webassembly-cpu";
    const inputUseCounts = new Array<number>(this.values.length).fill(0);
    const storageUseCounts = new Array<number>(this.values.length).fill(0);
    let matrixCounts: Map<ProgramSlot, number> | undefined;
    this.computations = Object.freeze(
      computations.map((computation) => {
        const captured = { ...computation };
        assertComputationCoefficient(captured.kind, captured.alphaBits);
        assertMatrixFlags(captured.kind, captured.matrixFlags);
        captured.inputs = Object.freeze([...captured.inputs]);
        captured.provenance = Object.freeze({ ...captured.provenance });
        if (captured.kind === "matmul-f32") {
          matrixCounts ??= new Map();
          assertMatrixComputation(this.values, captured, result, matrixCounts);
        }
        for (const input of captured.inputs) {
          inputUseCounts[input]! += 1;
          storageUseCounts[this.values[input]!.storageSlot]! += 1;
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

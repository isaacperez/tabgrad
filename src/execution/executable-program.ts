import type { TensorDevice } from "./backend.js";
import { tensorDType, type TensorDType } from "../shared/tensor-dtype.js";
import { assertComputationParameters, requireComputationSignature, type ComputationKind, type OperationFamily } from "./operation-contracts.js";
import { resolveTensorType } from "./operation-types.js";

export type ProgramSlot = number;

export interface ProgramProvenance {
  readonly operation: string;
  readonly source: string;
}

export interface ProgramValue {
  readonly slot: ProgramSlot;
  /** Canonical virtual storage slot; contiguous aliases cover its entire payload. */
  readonly storageSlot: ProgramSlot;
  readonly dtype: TensorDType;
  readonly device: TensorDevice;
  readonly layout: "contiguous";
  readonly shape: readonly number[];
  readonly source: "binding" | "computed" | "alias";
  readonly provenance: ProgramProvenance;
}

export interface LoweredComputation {
  readonly kind: ComputationKind;
  /** Captured binary32 coefficient, when required by the family. */
  readonly alphaBits?: number;
  /** Captured orientation, when required by the family. */
  readonly matrixFlags?: number;
  /** Ordered operand occurrences, including repeats; arity belongs to the operation. */
  readonly inputs: readonly ProgramSlot[];
  readonly output: ProgramSlot;
  readonly provenance: ProgramProvenance;
}

function copyProgramValue(value: ProgramValue): ProgramValue {
  const captured = { ...value };
  captured.shape = Object.freeze([...captured.shape]);
  captured.provenance = Object.freeze({ ...captured.provenance });
  return Object.freeze(captured);
}

function valueElements(value: ProgramValue, counts: Map<ProgramSlot, number>): number {
  const known = counts.get(value.slot);
  if (known !== undefined) return known;
  if (value.shape.some(dimension => !Number.isSafeInteger(dimension) || dimension < 0)) {
    throw new TypeError("Program storage requires nonnegative safe dimensions.");
  }
  const count = value.shape.includes(0) ? 0 : value.shape.reduce((size, dimension) => size * dimension, 1);
  if (!Number.isSafeInteger(count)) throw new TypeError("Program storage exceeds safe element arithmetic.");
  counts.set(value.slot, count);
  return count;
}

function requireContiguousValue(slot: ProgramSlot, values: readonly ProgramValue[], counts: Map<ProgramSlot, number>): ProgramValue {
  const value = values[slot];
  if (!Number.isSafeInteger(slot) || slot < 0 || value === undefined || value.slot !== slot
    || value.layout !== "contiguous"
    || (value.device !== "cpu" && value.device !== "webgpu")
    || !Number.isSafeInteger(value.storageSlot) || value.storageSlot < 0
    || (value.source !== "binding" && value.source !== "computed" && value.source !== "alias")) {
    throw new TypeError("Program values require valid slots and canonical contiguous metadata.");
  }
  tensorDType(value.dtype);
  const storage = values[value.storageSlot];
  if (storage === undefined || storage.slot !== value.storageSlot || storage.storageSlot !== storage.slot
    || (storage.source !== "binding" && storage.source !== "computed")
    || storage.dtype !== value.dtype || storage.device !== value.device || storage.layout !== value.layout
    || (value.source === "alias" ? value.storageSlot === slot : value.storageSlot !== slot)
    || valueElements(value, counts) !== valueElements(storage, counts)) {
    throw new TypeError("Program aliases must cover their canonical storage exactly.");
  }
  return value;
}

function assertMatrixComputation(family: Extract<OperationFamily, { geometry: "matrix" }>,
  values: readonly ProgramValue[], computation: LoweredComputation): void {
  const left = values[computation.inputs[0]!]!;
  const right = values[computation.inputs[1]!]!;
  const output = values[computation.output]!;
  const geometry = family.plan(left.shape, right.shape, computation.matrixFlags!);
  if (output.source !== "computed" || output.storageSlot !== output.slot
    || output.storageSlot === left.storageSlot || output.storageSlot === right.storageSlot
    || !Number.isSafeInteger(geometry.outputElements) || output.shape.length !== 2
    || output.shape[0] !== geometry.rows || output.shape[1] !== geometry.columns) {
    throw new TypeError("Matrix output must own distinct storage with the captured shape and device.");
  }
}

function assertShapedComputation(family: Extract<OperationFamily, { geometry: "pointwise" | "receiving" }>,
  values: readonly ProgramValue[], computation: LoweredComputation): void {
  const reduction = family.geometry === "receiving";
  const inputs = computation.inputs.map(slot => values[slot]!);
  const output = values[computation.output]!;
  const expected = reduction ? inputs[0]!.shape : family.plan(inputs.map(value => value.shape)).shape;
  if (output.source !== "computed" || output.storageSlot !== output.slot
    || inputs.some(input => input.storageSlot === output.storageSlot) || output.shape.length !== expected.length
    || (!reduction && output.shape.some((dimension, axis) => dimension !== expected[axis]))) {
    throw new TypeError("Shaped output must own distinct storage with its captured shape and device.");
  }
  if (reduction) {
    const geometry = family.plan([expected, output.shape]);
    if (geometry.shape.some((dimension, axis) => dimension !== expected[axis])) throw new TypeError("Receiving shape cannot expand its source.");
  }
}

export class ExecutableProgram {
  readonly formatVersion = 8;
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
    const elementCounts = new Map<ProgramSlot, number>();
    for (let slot = 0; slot < this.values.length; slot++) requireContiguousValue(slot, this.values, elementCounts);
    if (!Number.isSafeInteger(result) || result < 0 || this.values[result] === undefined) {
      throw new TypeError("Program result requires a valid value slot.");
    }
    this.computations = Object.freeze(
      computations.map((computation) => {
        const captured = { ...computation };
        const { family, types } = requireComputationSignature(captured.kind);
        assertComputationParameters(family, captured.alphaBits, captured.matrixFlags);
        captured.inputs = Object.freeze([...captured.inputs]);
        captured.provenance = Object.freeze({ ...captured.provenance });
        const dtype = resolveTensorType(types, this.values, captured.inputs);
        if (dtype === undefined || !Number.isSafeInteger(captured.output) || captured.output < 0
          || this.values[captured.output]?.dtype !== dtype) {
          throw new TypeError("Computation requires its declared input and result types.");
        }
        const device = this.values[captured.output]!.device;
        if (device !== this.values[result]!.device
          || captured.inputs.some(slot => this.values[slot]!.device !== device)) {
          throw new TypeError("Computation inputs and result require the selected device.");
        }
        if (family.geometry === "matrix") {
          assertMatrixComputation(family, this.values, captured);
        } else if (family.geometry !== "produced") {
          assertShapedComputation(family, this.values, captured);
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

import { TabgradError } from "../shared/errors.js";
import type { OptimizerLease, OptimizerLeaseFactory } from "./optimizer-lease.js";
import type { Tensor } from "./runtime.js";

export interface SGDOptions {
  lr?: number;
  momentum?: number;
  dampening?: number;
  weightDecay?: number;
  nesterov?: boolean;
  maximize?: boolean;
  foreach?: boolean;
  differentiable?: boolean;
  fused?: boolean;
}

export interface SGDParameterGroup extends SGDOptions {
  params: Tensor[];
  [metadata: string]: unknown;
}

const NUMBER_OPTIONS = ["lr", "momentum", "dampening", "weightDecay"] as const;
const BOOLEAN_OPTIONS = ["nesterov", "maximize", "foreach", "differentiable", "fused"] as const;
const OPTION_KEYS = new Set<string>([...NUMBER_OPTIONS, ...BOOLEAN_OPTIONS]);
const CONSTRUCTION_TOKEN = Symbol("SGDConstructionToken");
const FINALIZER = new FinalizationRegistry<OptimizerLease>((lease) => lease.finalize());

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateOptions(options: Record<string, unknown>, topLevel: boolean): void {
  if (topLevel && Object.keys(options).some((key) => !OPTION_KEYS.has(key))) {
    throw new TypeError("Unknown SGD option.");
  }
  for (const key of NUMBER_OPTIONS) {
    if (key in options && typeof options[key] !== "number") throw new TypeError(`${key} must be a number.`);
  }
  for (const key of BOOLEAN_OPTIONS) {
    if (key in options && typeof options[key] !== "boolean") throw new TypeError(`${key} must be a boolean.`);
  }
}

function supported(options: SGDOptions): void {
  if (options.momentum !== 0 || options.dampening !== 0 || options.weightDecay !== 0
    || options.nesterov === true || options.maximize === true || options.foreach === true
    || options.differentiable === true || options.fused === true) {
    throw new TabgradError("UNSUPPORTED_OPTIMIZER", "This SGD configuration is outside the supported basic CPU domain.");
  }
}

/** Checked native float32 scalar conversion. Arithmetic remains in Wasm. */
export function coefficientBits(alpha: number): number {
  if (Number.isFinite(alpha) && Math.abs(alpha) > 3.4028234663852886e38) {
    throw new RangeError("The SGD coefficient cannot be converted to float32 without overflow.");
  }
  return new Uint32Array(new Float32Array([alpha]).buffer)[0]!;
}

/** Session-constructed basic CPU SGD with ordinary runtime mutation ownership. */
export class SGD {
  readonly defaults: SGDOptions;
  readonly paramGroups: SGDParameterGroup[];
  readonly state = new Map<Tensor, never>();
  readonly #lease: OptimizerLease;
  readonly #registered: readonly (readonly Tensor[])[];
  readonly #groups: readonly SGDParameterGroup[];
  readonly #parameterArrays: readonly Tensor[][];

  constructor(...internal: unknown[]) {
    if (internal[0] !== CONSTRUCTION_TOKEN) throw new TypeError("Use session.sgd to create an optimizer.");
    this.#lease = internal[1] as OptimizerLease;
    this.paramGroups = internal[2] as SGDParameterGroup[];
    this.defaults = internal[3] as SGDOptions;
    this.#registered = this.paramGroups.map((group) => [...group.params]);
    this.#groups = [...this.paramGroups];
    this.#parameterArrays = this.paramGroups.map((group) => group.params);
    FINALIZER.register(this, this.#lease, this);
  }

  #checkStructure(): void {
    if (this.state.size !== 0 || this.paramGroups.length !== this.#registered.length
      || this.paramGroups.some((group, index) => group !== this.#groups[index]
        || group.params !== this.#parameterArrays[index] || !Array.isArray(group.params)
        || group.params.length !== this.#registered[index]!.length
        || group.params.some((parameter, occurrence) => parameter !== this.#registered[index]![occurrence]))) {
      throw new TabgradError("UNSUPPORTED_OPTIMIZER", "Manual state or parameter-group restructuring is unsupported.");
    }
  }

  zeroGrad(setToNone = true): void {
    this.#lease.assertOpen();
    if (arguments.length > 1 || typeof setToNone !== "boolean") throw new TypeError("zeroGrad requires a boolean.");
    this.#checkStructure();
    this.#lease.zeroGrad(setToNone);
  }

  step<Result>(closure?: () => Result): Result | undefined {
    this.#lease.assertOpen();
    if (arguments.length > 1 || (closure !== undefined && typeof closure !== "function")) {
      throw new TypeError("step closure must be a function.");
    }
    this.#checkStructure();
    const previous = this.#lease.beginStep();
    try {
      let result: Result | undefined;
      if (closure !== undefined) {
        this.#lease.setRecording(true);
        try { result = closure(); }
        finally { this.#lease.setRecording(false); }
      }
      this.#lease.assertOpen();
      this.#checkStructure();
      for (let index = 0; index < this.paramGroups.length; index += 1) {
        const group = this.paramGroups[index]!;
        validateOptions(group, false);
        supported(group);
        if (this.#lease.hasGradients(index)) this.#lease.stepGroup(index, coefficientBits(-group.lr!));
      }
      return result;
    } finally { this.#lease.setRecording(previous); }
  }

  close(): void {
    FINALIZER.unregister(this);
    this.#lease.close();
  }
}

/** Internal factory: frontend binding and semantic registration stay separate. */
export function createSGD(parameters: unknown, options: unknown, register: OptimizerLeaseFactory): SGD {
  if (options !== undefined && !object(options)) throw new TypeError("SGD options must be an object.");
  const supplied = options ?? {};
  validateOptions(supplied as Record<string, unknown>, true);
  const defaults: SGDOptions = {
    lr: 0.001, momentum: 0, dampening: 0, weightDecay: 0,
    nesterov: false, maximize: false, differentiable: false,
    ...supplied,
  };
  if (defaults.lr! < 0 || defaults.momentum! < 0 || defaults.weightDecay! < 0) {
    throw new RangeError("SGD learning rate, momentum and weight decay must be nonnegative.");
  }
  if (defaults.nesterov && (defaults.momentum! <= 0 || defaults.dampening !== 0)) {
    throw new RangeError("Nesterov requires positive momentum and zero dampening.");
  }
  if (!Array.isArray(parameters) || parameters.length === 0) throw new TypeError("SGD requires a nonempty parameter array.");
  const groups: SGDParameterGroup[] = object(parameters[0]) && "params" in parameters[0]
    ? [...parameters] as SGDParameterGroup[] : [{ params: parameters }];
  for (const group of groups) {
    if (!object(group) || !Array.isArray(group.params)) throw new TypeError("SGD group params must be an array.");
    validateOptions(group, false);
    for (const key of OPTION_KEYS) if (group[key] === undefined && key in defaults) group[key] = defaults[key as keyof SGDOptions];
  }
  // Complete intrinsic registration validation before rejecting native-valid
  // unsupported options, without admitting roots for a rejected constructor.
  const lease = register(groups.map((group) => group.params));
  try {
    supported(defaults);
    for (const group of groups) supported(group);
    for (const group of groups) {
      if (new Set(group.params).size !== group.params.length) {
        console.warn("optimizer contains a parameter group with duplicate parameters; in future, this will cause an error; see github.com/pytorch/pytorch/issues/40967 for more information");
      }
      group.params = [...group.params];
    }
    return new SGD(CONSTRUCTION_TOKEN, lease, groups, defaults);
  } catch (error) {
    try { lease.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "SGD construction and cleanup failed."); }
    throw error;
  }
}

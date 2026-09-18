import { inspectExecutionFailureContext, TabgradError } from "./errors.js";

/** A remote diagnostic, not a live exception object or Python proxy. */
export class PythonWorkerError extends Error {
  readonly code: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly executionContext: Readonly<Record<string, unknown>> | undefined;
  readonly errors: readonly PythonWorkerError[] | undefined;

  private constructor(failure: FailureRecord, seen = new Map<FailureRecord, PythonWorkerError>()) {
    super(failure.message);
    seen.set(failure, this);
    this.name = failure.name;
    if (failure.stack !== undefined) this.stack = failure.stack;
    this.code = failure.code;
    this.details = failure.details === undefined ? undefined : Object.freeze(failure.details);
    this.executionContext = failure.executionContext === undefined
      ? undefined : Object.freeze(failure.executionContext);
    if (failure.cause !== undefined) {
      this.cause = seen.get(failure.cause) ?? new PythonWorkerError(failure.cause, seen);
    }
    this.errors = failure.errors === undefined ? undefined : Object.freeze(
      failure.errors.map((item) => seen.get(item) ?? new PythonWorkerError(item, seen)),
    );
  }

  /** @internal */
  static fromFailure(failure: FailureRecord): PythonWorkerError { return new PythonWorkerError(failure); }
}

interface FailureRecord {
  name: string;
  message: string;
  stack: string | undefined;
  code: string | undefined;
  details: Record<string, unknown> | undefined;
  executionContext: Record<string, unknown> | undefined;
  cause?: FailureRecord;
  errors?: FailureRecord[];
}

/** Copy only diagnostics; never clone tensor state, interpreter objects or programs. */
export function describePythonFailure(error: unknown, seen = new Map<unknown, FailureRecord>()): FailureRecord {
  const previous = seen.get(error);
  if (previous !== undefined) return previous;
  const result: FailureRecord = {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    code: error instanceof TabgradError ? error.code : undefined,
    details: error instanceof TabgradError ? { ...error.details } : undefined,
    executionContext: undefined,
  };
  seen.set(error, result);
  const context = inspectExecutionFailureContext(error);
  if (context !== undefined) {
    const { program: _program, ...diagnostics } = context;
    result.executionContext = diagnostics;
  }
  if (error instanceof Error && error.cause !== undefined) {
    result.cause = describePythonFailure(error.cause, seen);
  }
  if (error instanceof AggregateError) {
    result.errors = error.errors.map((item: unknown) => describePythonFailure(item, seen));
  }
  return result;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPythonFailure(value: unknown, seen = new Set<unknown>()): value is FailureRecord {
  if (!isRecord(value)) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  return typeof value.name === "string" && typeof value.message === "string"
    && (value.stack === undefined || typeof value.stack === "string")
    && (value.code === undefined || typeof value.code === "string")
    && (value.details === undefined || isRecord(value.details))
    && (value.executionContext === undefined || isRecord(value.executionContext))
    && (value.cause === undefined || isPythonFailure(value.cause, seen))
    && (value.errors === undefined || (Array.isArray(value.errors)
      && value.errors.every((item: unknown) => isPythonFailure(item, seen))));
}

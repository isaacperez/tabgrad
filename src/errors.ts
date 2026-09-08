export type TabgradErrorCode =
  | "BACKEND_ABI_MISMATCH"
  | "BACKEND_CAPABILITY_MISMATCH"
  | "BACKEND_HASH_MISMATCH"
  | "BACKEND_LOAD_FAILED"
  | "BACKEND_MANIFEST_INVALID"
  | "BACKEND_STATUS_ERROR"
  | "BACKEND_TRAP"
  | "CLOSED_SESSION"
  | "CLOSED_TENSOR"
  | "DIFFERENT_SESSION"
  | "INVALID_DATA"
  | "INVALID_SHAPE"
  | "INVALID_TENSOR"
  | "RESOURCE_EXHAUSTED"
  | "SHAPE_MISMATCH"
  | "UNSUPPORTED_DEVICE"
  | "UNSUPPORTED_DTYPE"
  | "UNSUPPORTED_LAYOUT";

/** @internal */
export interface InternalExecutionFailureContext {
  readonly operation: string;
  readonly programValueSlot: number;
  readonly provenance: Readonly<{
    readonly operation: string;
    readonly source: string;
  }>;
  readonly program: unknown;
  readonly executionDomain: string;
  readonly backendEndpoints: readonly string[];
  readonly phase: string;
}

const EXECUTION_FAILURE_CONTEXTS = new WeakMap<
  TabgradError,
  InternalExecutionFailureContext
>();

export class TabgradError extends Error {
  readonly code: TabgradErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: TabgradErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TabgradError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/** @internal */
export function retainExecutionFailureContext(
  error: TabgradError,
  context: InternalExecutionFailureContext,
): TabgradError {
  if (!EXECUTION_FAILURE_CONTEXTS.has(error)) {
    EXECUTION_FAILURE_CONTEXTS.set(error, Object.freeze({
      ...context,
      provenance: Object.freeze({ ...context.provenance }),
      backendEndpoints: Object.freeze([...context.backendEndpoints]),
    }));
  }
  return error;
}

/** @internal */
export function inspectExecutionFailureContext(
  error: unknown,
): InternalExecutionFailureContext | undefined {
  return error instanceof TabgradError
    ? EXECUTION_FAILURE_CONTEXTS.get(error)
    : undefined;
}

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

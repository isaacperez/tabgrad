import type { WasmVariant } from "./cpu-backend.js";
import {
  type RuntimeSession,
  type RuntimeSessionOptions,
  createRuntimeSessionForTesting,
} from "./runtime.js";

export interface TestRuntimeSessionOptions extends RuntimeSessionOptions {
  readonly forceVariant: WasmVariant;
}

export function createTestRuntimeSession(
  options: TestRuntimeSessionOptions,
): RuntimeSession {
  return createRuntimeSessionForTesting(options);
}

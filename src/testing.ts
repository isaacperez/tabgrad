import type { WasmVariant } from "./cpu-backend.js";
import { inspectExecutionFailureContext } from "./errors.js";
import { ExecutableProgram } from "./executable-program.js";
import {
  countResidentProgramReferencesForTesting,
  type RuntimeSession,
  type RuntimeSessionOptions,
  createRuntimeSessionForTesting,
} from "./runtime.js";

export interface TestRuntimeSessionOptions extends RuntimeSessionOptions {
  readonly forceVariant: WasmVariant;
  readonly onProgramFormed?: (program: ExecutableProgram) => void;
  readonly beforeReadback?: () => void;
}

export interface TestExecutionFailureContext {
  readonly operation: string;
  readonly programValueSlot: number;
  readonly provenance: Readonly<{ readonly operation: string; readonly source: string }>;
  readonly program: ExecutableProgram;
  readonly executionDomain: string;
  readonly backendEndpoints: readonly string[];
  readonly phase: string;
}

export function createTestRuntimeSession(
  options: TestRuntimeSessionOptions,
): RuntimeSession {
  return createRuntimeSessionForTesting(
    options,
    options.onProgramFormed,
    options.beforeReadback,
  );
}

export function getTestExecutionFailureContext(
  error: unknown,
): TestExecutionFailureContext | undefined {
  const context = inspectExecutionFailureContext(error);
  if (context === undefined || !(context.program instanceof ExecutableProgram)) {
    return undefined;
  }
  return context as TestExecutionFailureContext;
}

export function getTestResidentProgramReferenceCount(
  session: RuntimeSession,
): number {
  return countResidentProgramReferencesForTesting(session);
}

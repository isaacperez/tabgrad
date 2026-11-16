import { createRuntimeSession, createWebGpuRuntimeSession, type RuntimeMemoryLimits } from "../../dist/index.js";
import { attachPython, type PythonBindingOptions, type PythonInterpreter } from "../../dist/python.js";

export async function configuredSessions(interpreter: PythonInterpreter): Promise<void> {
  const memoryLimits: RuntimeMemoryLimits = { cpuLinearMemoryBytes: 128 * 1024 * 1024, updateBackingBytes: 4096 };
  const options: PythonBindingOptions = { memoryLimits };
  const local = createRuntimeSession({ memoryLimits });
  const gpu = await createWebGpuRuntimeSession({ memoryLimits });
  const python = await attachPython(interpreter, options);
  const current: number = local.diagnostics().memoryLimits.cpuLinearMemoryBytes;
  const maximum: number | undefined = python.diagnostics().cpuMemoryCapacity?.artifactMaximumBytes;
  void current;
  void maximum;
  // @ts-expect-error Limits are readonly snapshots.
  local.diagnostics().memoryLimits.updateBackingBytes = 1;
  // @ts-expect-error Misspelled capacity settings cannot silently become defaults.
  createRuntimeSession({ memoryLimits: { cpuBytes: 4096 } });
  // @ts-expect-error Runtime byte limits are numeric.
  createRuntimeSession({ memoryLimits: { cpuLinearMemoryBytes: "128MiB" } });
  await python.close();
  await gpu.close();
  await local.close();
}

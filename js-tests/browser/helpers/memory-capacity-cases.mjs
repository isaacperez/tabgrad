function check(condition, message) {
  if (!condition) throw new Error(message);
}

/** Public configuration and imported-memory behavior in the actual browser realm. */
export async function checkMemoryCapacity(createSession) {
  const MiB = 1024 * 1024;
  const limits = { cpuLinearMemoryBytes: 128 * MiB, updateBackingBytes: 4096 };
  const larger = createSession({ memoryLimits: limits });
  limits.cpuLinearMemoryBytes = 2 * MiB;
  limits.updateBackingBytes = 0;
  let capacity;
  try {
    check(larger.diagnostics().backendLoads === 0, "Capacity reads prepared CPU.");
    check(larger.diagnostics().memoryLimits.cpuLinearMemoryBytes === 128 * MiB, "Capacity retained mutable input.");
    const input = larger.tensor([2]), result = input.add(input);
    check((await result.toArray())[0] === 4, "Configured CPU changed a numerical result.");
    const ready = larger.diagnostics();
    capacity = ready.cpuMemoryCapacity;
    check(capacity.artifactMaximumBytes === 256 * MiB, "Artifact ceiling differs from the matched profile.");
    check(capacity.linearMemoryLimitBytes === 128 * MiB && ready.wasmMemoryBytes === 2 * MiB,
      "Session maximum was ignored or preallocated.");
    result.close(); input.close();
  } finally { await larger.close(); }
  check(larger.diagnostics().cpuMemoryCapacity === null, "Closed CPU capacity retained its context.");
  check(capacity.linearMemoryLimitBytes === 128 * MiB, "A retained numeric snapshot changed at close.");

  const smaller = createSession({ memoryLimits: { cpuLinearMemoryBytes: 2 * MiB, updateBackingBytes: 0 } });
  let rejectedDomain;
  try {
    const input = smaller.tensor(new Float32Array(262136).fill(1));
    check((await input.toArray()).every(value => value === 1), "Borrowed input preparation failed.");
    const before = smaller.diagnostics(), output = input.add(input);
    try { await output.toArray(); } catch (error) {
      check(error.code === "RESOURCE_EXHAUSTED", "Capacity failure became another error.");
      rejectedDomain = error.details.capacityDomain;
    }
    check(rejectedDomain === "cpu-linear-memory", "The smaller CPU ceiling did not reject numerical allocation.");
    check(smaller.diagnostics().liveAllocationBytes === before.liveAllocationBytes, "Failed output changed borrowed ownership.");
    check((await input.toArray()).every(value => value === 1), "Failed output corrupted the borrowed input.");
    output.close(); input.close();
  } finally { await smaller.close(); }
  return { artifactMaximumBytes: capacity.artifactMaximumBytes, explicitCpuLimitBytes: capacity.linearMemoryLimitBytes,
    rejectedDomain, closed: smaller.diagnostics().liveAllocationBytes === 0 };
}

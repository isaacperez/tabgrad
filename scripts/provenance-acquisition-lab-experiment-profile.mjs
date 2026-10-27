import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { acquisitionFields as fields, isAcquisitionToken, isAcquisitionHash, isAcquisitionUint,
  requireAcquisition } from "./provenance-acquisition-record.mjs";
import { copyLabInputPlan, LAB_PROFILE_BYTES } from "./provenance-acquisition-lab-profile.mjs";
import { LAB_DIAGNOSTIC_CASES } from "./provenance-acquisition-lab-diagnostic-profile.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";

const check = value => requireAcquisition(value, "LAB_INPUT");
const overlaps = (a, b) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");

/** Three complete, independent laboratory inputs; shared anchors do not reuse mutable children. */
export function copyLabExperimentPlan(input) {
  check(fields(input, ["schemaVersion", "context", "diagnostic", "labs", "limits"]) && input.schemaVersion === 1
    && fields(input.context, ["operationId", "sourceRevision", "deadlineNs"]) && isAcquisitionToken(input.context.operationId)
    && /^[a-f0-9]{40}$/.test(input.context.sourceRevision) && isAcquisitionUint(input.context.deadlineNs)
    && BigInt(input.context.deadlineNs) > 0n && BigInt(input.context.deadlineNs) % 1000000n === 0n
    && BigInt(input.context.deadlineNs) / 1000000n <= 2147483647n
    && fields(input.diagnostic, ["path", "sha256"]) && isAcquisitionHash(input.diagnostic.sha256)
    && fields(input.labs, LAB_DIAGNOSTIC_CASES) && fields(input.limits, ["pollMs", "closeWaitMs"])
    && [input.limits.pollMs, input.limits.closeWaitMs].every(v => Number.isSafeInteger(v) && v > 0)
    && input.limits.pollMs <= input.limits.closeWaitMs);
  const labs = Object.fromEntries(LAB_DIAGNOSTIC_CASES.map(kind => [kind, copyLabInputPlan(input.labs[kind])]));
  const first = labs.A;
  check(new Set([input.context.operationId, ...Object.values(labs).map(p => p.context.operationId)]).size === 4);
  for (const [kind, p] of Object.entries(labs)) {
    check(p.context.sourceRevision === input.context.sourceRevision && p.diagnostic?.case === kind
      && p.diagnostic.path === input.diagnostic.path && p.diagnostic.sha256 === input.diagnostic.sha256
      && isDeepStrictEqual(p.tools, first.tools) && isDeepStrictEqual(p.expected, first.expected)
      && input.limits.closeWaitMs <= p.limits.retireMs);
    for (const root of ["cgroup", "proc", "tools", "pythonEnvironment"]) check(isDeepStrictEqual(p.roots[root], first.roots[root]));
    for (const other of Object.values(labs)) for (const name of ["scratch", "evidence"]) for (const target of ["scratch", "evidence"]) {
      const a = p.roots[name].path; const b = other.roots[target].path;
      check(name === target && a === b || !overlaps(a, b));
    }
  }
  const children = Object.values(labs).map(p => join(p.roots.scratch.path, p.context.operationId));
  check(children.every((a, i) => children.every((b, j) => i === j || !overlaps(a, b))));
  const allowance = Object.values(labs).reduce((sum, p) => sum + BigInt(p.context.deadlineNs), 0n);
  check(allowance + BigInt(input.limits.closeWaitMs) * 1000000n < BigInt(input.context.deadlineNs));
  const p = { ...JSON.parse(JSON.stringify(input)), labs };
  check(Buffer.byteLength(JSON.stringify(p)) <= LAB_PROFILE_BYTES); return freezeHostData(p);
}

/** Bind the independently expected diagnostic tokens before selecting any laboratory. */
export function validateLabExperimentDiagnostic(p, diagnostic) {
  check(diagnostic.sourceRevision === p.context.sourceRevision);
  const tokens = [p.context.operationId, ...Object.values(p.labs).map(l => l.context.operationId), ...Object.values(diagnostic.operations)];
  check(new Set(tokens).size === 7);
  for (const lab of Object.values(p.labs)) check(BigInt(diagnostic.timing.deadlineNs)
    + BigInt(lab.limits.prepareMs + lab.limits.retireMs) * 1000000n < BigInt(lab.context.deadlineNs));
}

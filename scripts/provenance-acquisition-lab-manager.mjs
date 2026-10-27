import { acquisitionFields as fields, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";
import { labPaths } from "./provenance-acquisition-lab-profile.mjs";

const check = value => requireAcquisition(value, "LAB_MANAGER");
const objectPath = value => typeof value === "string" && /^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(value);

function json(bytes) {
  check(Buffer.isBuffer(bytes));
  const text = bytes.toString("utf8"); check(Buffer.from(text).equals(bytes));
  try { return JSON.parse(text); } catch { check(false); }
}

/** Preserve originals separately. Only explicitly selected typed fields enter decisions. */
export function parseLabUnitPath(bytes) {
  const p = json(bytes);
  check(fields(p, ["type", "data"]) && p.type === "o" && Array.isArray(p.data)
    && p.data.length === 1 && objectPath(p.data[0]));
  return p.data[0];
}

function properties(bytes) {
  const p = json(bytes);
  check(fields(p, ["type", "data"]) && p.type === "a{sv}" && Array.isArray(p.data) && p.data.length === 1
    && p.data[0] && Object.getPrototypeOf(p.data[0]) === Object.prototype);
  return p.data[0];
}

function property(p, key, type) {
  check(Object.hasOwn(p, key)); const v = p[key];
  check(fields(v, ["type", "data"]) && v.type === type);
  if (["u", "t"].includes(type)) check(Number.isSafeInteger(v.data) && v.data >= 0 && (type !== "u" || v.data <= 0xffffffff));
  if (type === "i") check(Number.isInteger(v.data) && v.data >= -0x80000000 && v.data <= 0x7fffffff);
  if (type === "s") check(typeof v.data === "string" && v.data.isWellFormed());
  if (type === "b") check(typeof v.data === "boolean");
  return v.data;
}

export function parseLabUnit(bytes, expectedName) {
  const p = properties(bytes);
  const id = property(p, "Id", "s"); check(id === expectedName);
  const invocation = property(p, "InvocationID", "ay");
  check(Array.isArray(invocation) && invocation.length === 16
    && invocation.every(b => Number.isInteger(b) && b >= 0 && b <= 255) && invocation.some(Boolean));
  const job = property(p, "Job", "(uo)");
  check(Array.isArray(job) && job.length === 2 && Number.isInteger(job[0]) && job[0] >= 0 && job[0] <= 0xffffffff
    && typeof job[1] === "string" && (job[0] === 0 ? job[1] === "/" : /^\/org\/freedesktop\/systemd1\/job\/[0-9]+$/.test(job[1])));
  return freezeHostData({ id, invocationId: Buffer.from(invocation).toString("hex"), job: [...job],
    activeState: property(p, "ActiveState", "s"), subState: property(p, "SubState", "s"),
    collectMode: property(p, "CollectMode", "s") });
}

export function parseLabService(bytes, p) {
  const s = properties(bytes); const f = labPaths(p); const l = p.limits;
  const expected = { Type: ["s", "exec"], ControlGroup: ["s", f.group], Restart: ["s", "no"],
    Delegate: ["b", true], DelegateSubgroup: ["s", "keeper"], KillMode: ["s", "control-group"],
    KillSignal: ["i", 15], FinalKillSignal: ["i", 9], SendSIGKILL: ["b", true],
    RuntimeMaxUSec: ["t", Number(BigInt(p.context.deadlineNs) / 1000n)], RuntimeRandomizedExtraUSec: ["t", 0],
    TimeoutStartUSec: ["t", l.prepareMs * 1000], TimeoutStopUSec: ["t", l.stopMs * 1000],
    MemoryMax: ["t", Number(l.memoryBytes)], MemorySwapMax: ["t", Number(l.swapBytes)],
    TasksMax: ["t", l.tasks], CPUQuotaPerSecUSec: ["t", l.cpuPercent * 10000] };
  for (const [key, [type, value]] of Object.entries(expected)) check(property(s, key, type) === value);
  return freezeHostData({ mainPid: property(s, "MainPID", "u"), execCode: property(s, "ExecMainCode", "i"),
    execStatus: property(s, "ExecMainStatus", "i"), result: property(s, "Result", "s"),
    controlGroup: f.group, propertiesMatched: true });
}

/** GetAll call uses native typed JSON and applies call's timeout/no-auto-start flags. */
export function labBusArguments(p, method, unitPath = null) {
  check(["GetUnit", "GetAllUnit", "GetAllService"].includes(method));
  const base = ["--system", "--json=short", "--auto-start=no", "--allow-interactive-authorization=no",
    `--timeout=${p.limits.stopMs}ms`, "call", "org.freedesktop.systemd1"];
  if (method === "GetUnit") return Object.freeze([...base, "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager",
    "GetUnit", "s", labPaths(p).unit]);
  check(objectPath(unitPath));
  return Object.freeze([...base, unitPath, "org.freedesktop.DBus.Properties", "GetAll", "s",
    method === "GetAllUnit" ? "org.freedesktop.systemd1.Unit" : "org.freedesktop.systemd1.Service"]);
}

/** Unit before/after protects invocation binding, not an atomic cross-interface snapshot. */
export function reconcileLabManager(before, service, after) {
  check(before.id === after.id && before.invocationId === after.invocationId
    && before.collectMode === "inactive" && after.collectMode === "inactive");
  return freezeHostData({ ...after, service });
}

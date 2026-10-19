import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createAcquisitionControl, advanceAcquisitionControl } from "../../../scripts/provenance-acquisition-control.mjs";

const operationId = "1".repeat(32);
const hash = "a".repeat(64);
const header = { recordType: "acq_header_v1", operationId, state: "pending", authorizationRef: "2".repeat(32),
  profileSha256: hash, recipeSha256: hash, inputEvidenceSha256: hash, toolEvidenceSha256: hash,
  priorStateMode: "initial", priorStateSha256: null, declaredLimitsSha256: hash,
  t0MonotonicNs: "7", startedUtc: "2026-01-02T03:04:05.006Z", clockEvidenceSha256: hash,
  deadlineUtc: "2026-01-02T03:05:05.006Z" };
const bytes = Buffer.from(JSON.stringify(header) + "\n");
const digest = createHash("sha256").update(bytes).digest("hex");
const context = (role = "supervisor", changes = {}) => ({ role, operationId, expectedHeaderSha256: digest,
  profileSha256: hash, t0MonotonicNs: "7", deadlineNs: "1000", ...changes });
const envelope = (state, kind, extra = {}) => ({ kind, actor: state.context.role, operationId: state.context.operationId,
  phase: state.phase, actionId: null, atNs: "1", ...extra });
function request(state, effect, phase = "setup", extra = {}) {
  return advanceAcquisitionControl(state, envelope(state, "request", { phase, actionId: state.nextActionId, effect, ...extra }));
}
function complete(state, extra = {}) {
  return advanceAcquisitionControl(state, envelope(state, "complete", { phase: state.pending.phase,
    actionId: state.pending.actionId, ok: true, code: null, bytes: null, peer: null, ...extra }));
}
function preparedSupervisor() {
  let state = request(createAcquisitionControl(context()), "write_header").state;
  state = complete(state).state;
  state = request(state, "read_header").state;
  return complete(state, { bytes }).state;
}
function readySupervisor() {
  const state = request(preparedSupervisor(), "peer_ready").state;
  return complete(state, { peer: { actor: "watchdog", operationId, phase: "setup",
    actionId: "3", headerSha256: digest } }).state;
}

test("literal handshake has separate actor expectations and exact pending-action identities", () => {
  const initial = createAcquisitionControl(context());
  assert.equal(initial.gate, "pending");
  const first = request(initial, "write_header");
  assert.deepEqual(first.actions, [{ actor: "supervisor", operationId, phase: "setup", actionId: "1", kind: "write_header" }]);
  assert.equal(initial.pending, null);
  assert.equal(Object.isFrozen(first.state.pending), true);
  const s = preparedSupervisor();
  assert.equal(s.gate, "pending");
  assert.equal(s.stage, "read");
  let w = request(createAcquisitionControl(context("watchdog")), "verify_header").state;
  assert.equal(w.gate, "pending");
  w = complete(w, { bytes }).state;
  assert.equal(w.gate, "ready");
  assert.equal(s.gate, "pending");
  const ready = readySupervisor();
  assert.equal(ready.gate, "ready");
  assert.equal(ready.stage, "bound");
  assert.equal(ready.pending, null);
  assert.equal(ready.firstFailure, null);
});

test("contexts reject invalid scalar domains and getters without invoking them", () => {
  for (const changes of [ { role: "client" }, { operationId: "1" }, { expectedHeaderSha256: null },
    { profileSha256: "g".repeat(64) }, { t0MonotonicNs: "18446744073709551616" },
    { deadlineNs: "0" }, { deadlineNs: "01" }, { extra: "unexpected" } ]) {
    assert.throws(() => createAcquisitionControl(context("supervisor", changes)), { code: "CONTROL_CONTEXT" });
  }
  const input = context();
  Object.defineProperty(input, "role", { get() { assert.fail("getter invoked"); }, enumerable: true });
  assert.throws(() => createAcquisitionControl(input), { code: "CONTROL_CONTEXT" });
  const mutable = context();
  const state = createAcquisitionControl(mutable);
  mutable.deadlineNs = "9000";
  assert.equal(state.context.deadlineNs, "1000");
});

test("watchdog checks each independent expectation, malformed bytes and exact original hash", () => {
  for (const changes of [{}, { operationId: "3".repeat(32) }, { profileSha256: "b".repeat(64) },
    { t0MonotonicNs: "8" }, { expectedHeaderSha256: "f".repeat(64) }]) {
    let state = request(createAcquisitionControl(context("watchdog", changes)), "verify_header").state;
    state = complete(state, { bytes }).state;
    assert.equal(state.gate, Object.keys(changes).length ? "revoked" : "ready");
  }
  for (const invalid of [bytes.subarray(0, -1), Buffer.from("{}\n"), Buffer.alloc(32769), "not bytes", null]) {
    const state = request(createAcquisitionControl(context("watchdog")), "verify_header").state;
    assert.equal(complete(state, { bytes: invalid }).state.gate, "revoked");
  }
});

test("wrong, duplicate and concurrent confirmations revoke without replacing the first actor failure", () => {
  const state = request(createAcquisitionControl(context()), "write_header").state;
  for (const changes of [{ actionId: "2" }, { actor: "watchdog" }, { operationId: "9".repeat(32) },
    { phase: "close" }, { unexpected: "field" }]) {
    const bad = complete(state, changes).state;
    assert.equal(bad.gate, "revoked");
    assert.equal(bad.firstFailure.code, "protocol");
    const stopped = advanceAcquisitionControl(bad, envelope(bad, "stop", { atNs: "2", code: "storage" })).state;
    assert.deepEqual(stopped.firstFailure, bad.firstFailure);
  }
  const settled = complete(state).state;
  const duplicate = advanceAcquisitionControl(settled, envelope(settled, "complete", {
    actionId: "1", ok: true, code: null, bytes: null, peer: null,
  })).state;
  assert.equal(duplicate.gate, "revoked");
  assert.equal(request(state, "write_header").state.gate, "revoked");
  assert.equal(request(createAcquisitionControl(context("watchdog")), "write_header").state.gate, "revoked");
});

test("revocation and clock failure cannot be undone by late successful I/O or peer readiness", () => {
  const pending = request(preparedSupervisor(), "peer_ready").state;
  const stopped = advanceAcquisitionControl(pending, envelope(pending, "stop", { code: "observer", atNs: "2" })).state;
  const late = complete(stopped, { atNs: "3", peer: { actor: "watchdog", operationId,
    phase: "setup", actionId: "3", headerSha256: digest } }).state;
  assert.equal(late.gate, "revoked");
  assert.deepEqual(late.firstFailure, { code: "observer", atNs: "2" });
  for (const atNs of [null, "-1", "18446744073709551616", "0"]) {
    const bad = advanceAcquisitionControl(pending, envelope(pending, "tick", { atNs })).state;
    assert.equal(bad.gate, "revoked");
    assert.deepEqual(bad.firstFailure, { code: "clock", atNs: null });
  }
  const within = advanceAcquisitionControl(pending, envelope(pending, "tick", { atNs: "1000" })).state;
  assert.equal(within.gate, "pending");
  const after = advanceAcquisitionControl(pending, envelope(pending, "tick", { atNs: "1001" })).state;
  assert.deepEqual(after.firstFailure, { code: "deadline", atNs: "1001" });
  const wide = createAcquisitionControl(context("watchdog", { deadlineNs: "18446744073709551615" }));
  assert.equal(advanceAcquisitionControl(wide, envelope(wide, "tick", { atNs: "9007199254740993" })).state.lastAtNs, "9007199254740993");
  const accessor = envelope(pending, "tick");
  Object.defineProperty(accessor, "kind", { get() { assert.fail("event getter invoked"); } });
  assert.equal(advanceAcquisitionControl(pending, accessor).state.gate, "revoked");
});

test("cleanup remains accountable after revocation and repeated actions retain no history", () => {
  let state = readySupervisor();
  const keys = Object.keys(state);
  for (let i = 0; i < 127; i++) {
    state = request(state, "write_progress", "observe").state;
    state = complete(state).state;
    assert.deepEqual(Object.keys(state), keys);
    assert.equal(state.pending, null);
  }
  state = advanceAcquisitionControl(state, envelope(state, "stop", { code: "storage" })).state;
  const first = state.firstFailure;
  state = request(state, "finish_progress", "close", { atNs: null }).state;
  state = complete(state, { atNs: null }).state;
  assert.equal(state.progressFinished, true);
  state = request(state, "close_writer", "close", { atNs: null }).state;
  state = complete(state, { atNs: null }).state;
  assert.equal(state.localClosed, true);
  assert.equal(state.gate, "revoked");
  assert.deepEqual(state.firstFailure, first);
});

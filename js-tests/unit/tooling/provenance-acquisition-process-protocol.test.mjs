import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACQUISITION_PROCESS_MESSAGE_LIMIT, encodeAcquisitionProcessMessage, decodeAcquisitionProcessMessage,
  validateProcessTiming, sendAcquisitionProcessMessage,
} from "../../../scripts/provenance-acquisition-process-protocol.mjs";

const op = "1".repeat(32);
const timing = () => ({ heartbeatMs: 50, peerTimeoutMs: 3000, termAfterMs: 500, killAfterMs: 1000, closeWaitMs: 2000 });

test("closed pulse encoding matches independent literal bytes and preserves uint64 without coercion", () => {
  const wire = `{"version":1,"kind":"pulse","actor":"watchdog","operationId":"${op}","id":"7","payload":{"atNs":"18446744073709551615"}}`;
  assert.equal(encodeAcquisitionProcessMessage("pulse", "watchdog", op, "7", { atNs: "18446744073709551615" }), wire);
  assert.equal(decodeAcquisitionProcessMessage(wire).payload.atNs, "18446744073709551615");
});

test("wire limits, invalid JSON, duplicate fields and unknown nested fields fail with a closed diagnostic", () => {
  const valid = encodeAcquisitionProcessMessage("pulse", "watchdog", op, "7", { atNs: "1" });
  for (const wire of [Buffer.from(valid), " "+valid, valid+"\n", "[", "x".repeat(ACQUISITION_PROCESS_MESSAGE_LIMIT+1),
    valid.replace('"version":1', '"version":2,"version":1'), valid.replace('"atNs":"1"', '"atNs":"1","extra":"hidden"'),
    valid.replace('"atNs":"1"', '"atNs":"01"'), valid.replace('"actor":"watchdog"', '"actor":"client"')]) {
    assert.throws(() => decodeAcquisitionProcessMessage(wire), { code: "PROCESS_PROTOCOL" });
  }
});

test("accessors, exotic objects and symbols cannot become outbound protocol data", () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, "atNs", { enumerable: true, get() { reads++; return "1"; } });
  for (const payload of [accessor, Object.assign(Object.create({ inherited: true }), { atNs: "1" }), { atNs: "1", [Symbol()]: "x" }]) {
    assert.throws(() => encodeAcquisitionProcessMessage("pulse", "watchdog", op, "1", payload), { code: "PROCESS_PROTOCOL" });
  }
  assert.equal(reads, 0);
});

test("commands cannot cross actor responsibilities or smuggle free diagnostics", () => {
  for (const [actor, payload] of [["watchdog", { command: "prepare", data: null }],
    ["watchdog", { command: "append", data: null }], ["supervisor", { command: "shell", data: "private" }]]) {
    assert.throws(() => encodeAcquisitionProcessMessage("request", actor, op, "1", payload), { code: "PROCESS_PROTOCOL" });
  }
  assert.throws(() => encodeAcquisitionProcessMessage("fault", "supervisor", op, "0", { code: "private detail" }), { code: "PROCESS_PROTOCOL" });
});

test("timing is explicit, finite and ordered, with independently varied boundaries", () => {
  assert.deepEqual(validateProcessTiming(timing()), timing());
  for (const change of [{ heartbeatMs: 0 }, { heartbeatMs: 3000 }, { peerTimeoutMs: 50 },
    { termAfterMs: 1000 }, { killAfterMs: 2000 }, { closeWaitMs: 2147483648 }, { termAfterMs: 1.5 }, { extra: 1 }]) {
    assert.throws(() => validateProcessTiming({ ...timing(), ...change }), { code: "PROCESS_INPUT" });
  }
});

test("transport success awaits its callback but does not invent a peer reply or treat backpressure as rejection", async () => {
  let confirm;
  const endpoint = { connected: true, send(wire, callback) { confirm = callback; return false; } };
  let done = false;
  const sent = sendAcquisitionProcessMessage(endpoint, "bounded").then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  confirm(null);
  await sent;
  assert.equal(done, true);
  await assert.rejects(sendAcquisitionProcessMessage({ connected: false }, "bounded"), { message: "PROCESS_CHANNEL" });
  await assert.rejects(sendAcquisitionProcessMessage({ connected: true, send(wire, callback) { callback(new Error("private")); } }, "bounded"),
    { message: "PROCESS_CHANNEL" });
});

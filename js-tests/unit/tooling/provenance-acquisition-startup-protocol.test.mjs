import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnteringAcquisitionHostController } from "../../../scripts/provenance-acquisition-host.mjs";
import { enterAcquisitionHost } from "../../../scripts/provenance-acquisition-host-io.mjs";
import {
  encodeStartupGuardMessage, decodeStartupGuardMessage, encodeStartupGuardStop, decodeStartupGuardStop,
} from "../../../scripts/provenance-acquisition-startup-protocol.mjs";
import { ACQUISITION_PROCESS_MESSAGE_LIMIT } from "../../../scripts/provenance-acquisition-process-protocol.mjs";
import { hostProfile, hostModel } from "../../fixtures/provenance-acquisition-host.mjs";

test("guard wire preserves a closed host/entry report and rejects malformed or extended input", async () => {
  const model = hostModel({ enter: true });
  const controller = await createEnteringAcquisitionHostController(hostProfile(), "guard", { clock: () => 101n,
    openHost: (p, r) => enterAcquisitionHost(p, r, { port: model.port, clock: () => 101n }),
  });
  const report = await controller.poll();
  const value = { version: 1, profileSha256: "a".repeat(64), pid: 777, sequence: "1", phase: "observation", report };
  const wire = encodeStartupGuardMessage(value);
  assert.deepEqual(decodeStartupGuardMessage(wire), value);
  for (const bad of ["{}", wire + " ", wire.replace('"version":1', '"version":1,"version":1'),
    " ".repeat(ACQUISITION_PROCESS_MESSAGE_LIMIT + 1), JSON.stringify({ ...value, extra: true }),
    JSON.stringify({ ...value, sequence: "0" }), JSON.stringify({ ...value, phase: "ready" }),
    JSON.stringify({ ...value, report: { ...report, entry: { state: "unknown", error: null } } })]) {
    assert.throws(() => decodeStartupGuardMessage(bad));
  }
  const accessor = { ...value };
  Object.defineProperty(accessor, "pid", { enumerable: true, get() { throw Error("must not call"); } });
  assert.throws(() => encodeStartupGuardMessage(accessor), { code: "PROCESS_PROTOCOL" });
  await controller.close();
});

test("stop wire binds the original operation and a closed existing cause", () => {
  const operation = "1".repeat(32);
  const wire = encodeStartupGuardStop(operation, "peer");
  assert.equal(decodeStartupGuardStop(wire, operation), "peer");
  for (const bad of [wire + "\n", wire.replace('"peer"', '"retry"'), JSON.stringify({ version: 1, operationId: operation, code: "peer", reopen: true })]) {
    assert.throws(() => decodeStartupGuardStop(bad, operation));
  }
  assert.throws(() => decodeStartupGuardStop(wire, "2".repeat(32)));
});

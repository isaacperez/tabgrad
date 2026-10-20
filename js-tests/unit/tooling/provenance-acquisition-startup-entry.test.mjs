import assert from "node:assert/strict";
import { test } from "node:test";
import { openAcquisitionHost, enterAcquisitionHost } from "../../../scripts/provenance-acquisition-host-io.mjs";
import { failedHostReport, validateHostReport } from "../../../scripts/provenance-acquisition-host-profile.mjs";
import { hostModel, hostProfile, deferred } from "../../fixtures/provenance-acquisition-host.mjs";

test("explicit entry writes only self once through the retained own identity, then verifies membership", async () => {
  for (const role of ["supervisor", "watchdog", "guard"]) {
    const m = hostModel({ enter: true });
    const io = await enterAcquisitionHost(hostProfile(), role, { port: m.port, clock: () => 101n });
    const writes = m.calls.filter(c => c.kind === "write");
    assert.deepEqual(writes.map(c => [c.name, c.text, c.position]), [["cgroup.procs", "0", 0]]);
    const writer = m.handles.get(writes[0].fd);
    assert.equal(writer.node, m.nodes[role].children.get("cgroup.procs"));
    assert.equal(io.snapshot().entry.state, "verified");
    await io.close();
    assert([...m.handles.values()].every(h => h.closed));
  }
  const m = hostModel();
  const io = await openAcquisitionHost(hostProfile(), "supervisor", m.port);
  assert.equal(Object.hasOwn(io.snapshot(), "entry"), false);
  assert.equal(m.calls.filter(c => c.kind === "write").length, 0);
  await io.close();
});

test("entry never retries ambiguous/partial writes and retains placement independently of close uncertainty", async () => {
  for (const outcome of [() => { throw Error("synthetic denied"); }, () => ({ bytesWritten: 0 }), () => ({ bytesWritten: 2 })]) {
    const m = hostModel({ enter: true, beforeWrite: outcome, beforeClose: () => { throw Error("synthetic close"); } });
    await assert.rejects(enterAcquisitionHost(hostProfile(), "guard", { port: m.port, clock: () => 101n }), error => {
      assert.equal(error.code, "HOST_ENTRY");
      assert.equal(error.closeError, "HOST_CLOSE");
      assert.deepEqual(error.entry, { state: "unknown", error: "HOST_ENTRY" });
      const report = failedHostReport("guard", hostProfile().operationId, error);
      assert.equal(report.ioClosed, "unknown");
      assert.deepEqual(report.entry, error.entry);
      validateHostReport(report, "guard");
      return true;
    });
    assert.equal(m.calls.filter(c => c.kind === "write").length, 1);
    assert.equal(m.calls.filter(c => c.kind === "close").length, m.handles.size);
  }
});

test("identity/clock failure cannot issue entry; acknowledged write is insufficient for membership", async () => {
  for (const clock of [() => 99n, () => 10000100n, () => { throw Error("synthetic clock"); }]) {
    const m = hostModel({ enter: true });
    await assert.rejects(enterAcquisitionHost(hostProfile(), "supervisor", { port: m.port, clock }));
    assert.equal(m.calls.filter(c => c.kind === "write").length, 0);
    assert([...m.handles.values()].every(h => h.closed));
  }
  const noMove = hostModel({ enter: true, beforeWrite: () => ({ bytesWritten: 1 }) });
  await assert.rejects(enterAcquisitionHost(hostProfile(), "guard", { port: noMove.port, clock: () => 101n }), e => {
    assert.equal(e.code, "HOST_MEMBER"); assert.equal(e.entry.state, "acknowledged"); return true;
  });
  const alias = hostModel({ enter: true });
  const original = alias.port.open;
  alias.port.open = async (path, mode) => {
    const h = await original(path, mode);
    if (path.endsWith("/cgroup.procs") && mode & alias.port.constants.O_WRONLY) {
      h.stat = async () => ({ dev: 1n, ino: 9999n, nlink: 1n, isFile: () => true });
    }
    return h;
  };
  await assert.rejects(enterAcquisitionHost(hostProfile(), "guard", { port: alias.port, clock: () => 101n }), { code: "HOST_IDENTITY" });
  assert.equal(alias.calls.filter(c => c.kind === "write").length, 0);
});

test("late completion and a regressive clock keep the verified effect but never admit a route", async () => {
  for (const late of [10000100n, 100n]) {
    const pending = deferred();
    const m = hostModel({ enter: true, beforeWrite: () => pending.promise });
    let at = 101n;
    const work = enterAcquisitionHost(hostProfile(), "watchdog", { port: m.port, clock: () => at });
    while (!m.calls.some(c => c.kind === "write")) await new Promise(resolve => setImmediate(resolve));
    at = late; pending.resolve();
    await assert.rejects(work, error => {
      assert.equal(error.code, late === 100n ? "HOST_CLOCK" : "HOST_DEADLINE");
      assert.equal(error.entry.state, "verified");
      assert.equal(error.closeError, null); return true;
    });
    assert.equal(m.calls.filter(c => c.kind === "write").length, 1);
    assert([...m.handles.values()].every(h => h.closed));
  }
});

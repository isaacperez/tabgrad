import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquisitionSha256 } from "../../../scripts/provenance-acquisition-record.mjs";
import { LabFiles } from "../../../scripts/provenance-acquisition-lab-files.mjs";
import { NativeLabIO } from "../../../scripts/provenance-acquisition-lab-io.mjs";
import { LabKernel } from "../../../scripts/provenance-acquisition-lab-kernel.mjs";
import { labPaths } from "../../../scripts/provenance-acquisition-lab-profile.mjs";
import { labProfile, labKernelModel, labNativePorts, labWorkerPorts } from "../../fixtures/provenance-acquisition-lab.mjs";
import { deferred } from "../../fixtures/provenance-acquisition-host.mjs";

const checks = { work() {}, retire() {} };

/** Real shared reader on finite proc nodes, real evidence files; no host/tool reads. */
async function fixture(t, worker = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tabgrad-lab-process-files-")));
  const p = labProfile(); p.roots.evidence.path = root;
  const reads = new WeakMap();
  const model = labKernelModel(p, { beforeRead(node, _bytes, _offset, _length, position) {
    if (node.name === "stat" && position === 0) {
      const sample = reads.get(node) ?? 0; reads.set(node, sample + 1);
      node.text = node.text.replace(/\(node(?:-before|-after)?\)/, sample === 0 ? "(node-before)" : "(node-after)");
    }
  } });
  const reader = new LabKernel(p, checks, model.port);
  const files = new LabFiles(p, checks.work); const retirement = new LabFiles(p, checks.retire);
  const ports = worker ? labWorkerPorts(p) : labNativePorts(p);
  let io;
  t.after(async () => {
    if (worker) ports.endDaemon(); else await ports.kernel.effect("unit.kill");
    if (io) await io.close();
    await reader.close();
    assert.equal((await files.close()).retained, 0);
    assert.equal((await retirement.close()).retained, 0);
    assert.equal(reader.snapshot().handles.retained, 0);
    await rm(root, { recursive: true, force: true });
  });
  const records = { observer: await reader.open() };
  for (const [role, pid, ppid] of [["keeper", 1001, 2], ["worker", 1002, 1001], ["dockerd", 1003, 1002], ["containerd", 1004, 1003]]) {
    const node = model.addProcess(pid, pid, ppid, true);
    node.children.get("cgroup").text = `0::${role === "keeper" ? labPaths(p).keeper : labPaths(p).infra}\n`;
    records[role] = await reader.process(role, pid);
    ports.processes[role] = records[role].data;
  }
  ports.kernel.open = async () => records.observer;
  ports.kernel.process = async (role, pid) => {
    assert.equal(String(pid), records[role].data.pid); return records[role];
  };
  // Prerequisite roots/tools and manager/daemon remain finite ports. Every
  // evidence write, readback, label guard and record hash uses the actual writer.
  ports.files = realFiles(files, ports.files);
  ports.retirementFiles = realFiles(retirement, ports.retirementFiles);
  io = new NativeLabIO(p, checks, ports);
  return { p, ports, records, files, retirement, io };
}

function realFiles(files, prerequisites) {
  return { ...prerequisites, write: files.write.bind(files), json: files.json.bind(files),
    read: files.read.bind(files), readJson: files.readJson.bind(files),
    verifyPrefix: files.verifyPrefix.bind(files), snapshot: files.snapshot.bind(files) };
}

async function savedProcess(files, label, record) {
  assert.deepEqual(Object.keys(record.originals), ["statBefore", "status", "cgroup", "statAfter"]);
  assert.notDeepEqual(record.originals.statBefore, record.originals.statAfter);
  assert.deepEqual(await files.readJson(`${label}.json`), record.data);
  for (const [key, bytes] of Object.entries(record.originals)) {
    const name = `${label}.${key.toLowerCase()}`;
    assert.deepEqual(await files.read(name), bytes);
    assert.deepEqual(record.data.sources[key], { bytes: bytes.length, sha256: acquisitionSha256(bytes) });
    assert.deepEqual(files.snapshot().records[name], { label: name, ...record.data.sources[key] });
  }
}

test("shared process records compose with the real writer at observer and exterior sites", async t => {
  const f = await fixture(t); await f.io.open();
  await savedProcess(f.files, "observer", f.records.observer);
  await f.io.launch();
  for (const label of ["keeper.json", "ready.json"]) await f.files.write(label, f.ports.originals.get(label));
  await f.io.readiness();
  await savedProcess(f.retirement, "keeper.exterior", f.records.keeper);
  for (const role of ["worker", "dockerd", "containerd"]) await savedProcess(f.files, `${role}.exterior`, f.records[role]);
  assert.equal(f.io.snapshot().workEntryObserved, true);
});

test("worker process originals preserve both stat samples, identity and source associations", async t => {
  const f = await fixture(t, true); const ready = deferred(); const save = f.ports.files.json;
  f.ports.files.json = async (label, value, limit) => {
    const result = await save(label, value, limit); if (label === "ready.json") ready.resolve(); return result;
  };
  // NativeLabIO retains this same file-owner object for publication.
  const running = f.io.worker();
  await Promise.race([ready.promise, running.then(() => assert.fail("worker unexpectedly ended"))]);
  for (const role of ["worker", "dockerd", "containerd"]) await savedProcess(f.files, role, f.records[role]);
  f.ports.endDaemon(); await assert.rejects(running, { code: "LAB_WORKER" });
});

test("a later original publication failure retains earlier bytes without JSON or overwrite", async t => {
  const f = await fixture(t); const occupied = `${labPaths(f.p).prefix}.observer.status`;
  await writeFile(occupied, "keep existing", { mode: 0o600 });
  await assert.rejects(f.io.open(), { code: "EEXIST" });
  assert.deepEqual(await f.files.read("observer.statbefore"), f.records.observer.originals.statBefore);
  assert.equal((await readFile(occupied)).toString(), "keep existing");
  assert.equal(await f.files.read("observer.cgroup"), null);
  assert.equal(await f.files.read("observer.statafter"), null);
  assert.equal(await f.files.readJson("observer.json"), null);
  assert.deepEqual(f.files.snapshot().unpreservedRecords, ["observer.status"]);
  assert.equal(f.io.snapshot().pendingOperations, 0);
  assert.equal(f.io.snapshot().launched, false);
});

test("unrelated uppercase, path and malformed labels remain rejected by the real writer", async t => {
  const f = await fixture(t);
  for (const label of ["observer.statBefore", "Observer", "../outside", "observer/path", ".hidden", "x".repeat(129)]) {
    await assert.rejects(f.files.write(label, Buffer.from("finite")), { code: "LAB_PROFILE" });
  }
  assert.deepEqual(f.files.snapshot().records, {});
  assert.deepEqual(f.files.snapshot().unpreservedRecords, []);
});

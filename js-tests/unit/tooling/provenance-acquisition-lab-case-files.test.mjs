import assert from "node:assert/strict";
import { test } from "node:test";
import { LabCaseFiles } from "../../../scripts/provenance-acquisition-lab-case-files.mjs";
import { LabHandles } from "../../../scripts/provenance-acquisition-lab-command.mjs";
import { AcquisitionRecordError } from "../../../scripts/provenance-acquisition-record.mjs";
import { caseFilesModel } from "../../fixtures/provenance-acquisition-case-files.mjs";
import { buildLabCaseProfiles } from "../../../scripts/provenance-acquisition-lab-case-profile.mjs";
import { copyCaptureAttemptProfile } from "../../../scripts/provenance-acquisition-capture-attempt-profile.mjs";
import { copyPlacementProfile } from "../../../scripts/provenance-acquisition-placement-profile.mjs";
import { copyActivationProfile } from "../../../scripts/provenance-acquisition-activation-profile.mjs";
import { copyLaunchProfile } from "../../../scripts/provenance-acquisition-launch-profile.mjs";
import { hostProfile } from "../../fixtures/provenance-acquisition-host.mjs";

test("one case stages only its fixed launcher closure and nine independent logical reservations", async () => {
  const m = await caseFilesModel({ shortWrite: 3 }); const handles = new LabHandles();
  try {
    const owner = new LabCaseFiles(m.lab, m.plan, "A", { check() {}, command: m.command, handles,
      files: m.files, retirementFiles: m.files, filesystem: m.port });
    assert.deepEqual(m.calls, []); const result = await owner.prepare();
    assert.equal(Object.keys(result.raw).length, 9); assert.equal(Object.keys(result.assets).length, 5);
    assert.equal(result.raw.control.capacity, 890); assert.equal(result.raw.progress.capacity, 960 * 1024);
    assert.equal(new Set(Object.values(result.raw).map(v => `${v.identity.dev}:${v.identity.ino}`)).size, 9);
    assert(Object.values(result.raw).every(v => v.bytes === 0)); assert.equal(result.physicalReservation, "unqualified");
    const profile = await owner.writeInput("profile.json", Buffer.from("canonical input")); assert.equal(profile.bytes, 15);
    assert.equal(m.calls.filter(c => c[0] === "command").length, 1);
    await handles.closeAll(); assert([...m.handles.values()].every(h => h.closed));
  } finally { await handles.closeAll(); await m.close(); }
});

test("a bad source identity retains the prepared partial stage and cannot create record reservations", async () => {
  const m = await caseFilesModel(); const handles = new LabHandles();
  try {
    m.plan.launcherFiles["provenance-acquisition-launch.mjs"].sha256 = "0".repeat(64);
    const owner = new LabCaseFiles(m.lab, m.plan, "A", { check() {}, command: m.command, handles,
      files: m.files, retirementFiles: m.files, filesystem: m.port });
    await assert.rejects(owner.prepare(), { code: "LAB_IDENTITY" }); assert.equal(owner.snapshot().firstFailure, "LAB_IDENTITY");
    assert.deepEqual(owner.snapshot().raw, {}); assert(m.records.has(`${owner.prefix}.files-partial.json`));
    await owner.preserveFailure(); assert(owner.snapshot().preservationComplete);
    await handles.closeAll(); assert([...m.handles.values()].every(h => h.closed));
  } finally { await handles.closeAll(); await m.close(); }
});

test("observed case objects compose profiles accepted by all existing codecs without mounting guard evidence", async () => {
  const m = await caseFilesModel(); const handles = new LabHandles();
  try {
    const files = new LabCaseFiles(m.lab, m.plan, "A", { check() {}, command: m.command, handles,
      files: m.files, retirementFiles: m.files, filesystem: m.port });
    await files.prepare(); const operationId = m.plan.operations.A;
    const profiles = await buildLabCaseProfiles({ lab: m.lab, plan: m.plan, kind: "A", t0MonotonicNs: "1000",
      startedUtc: "2026-01-02T03:04:05.006Z", caseFiles: files, groups: hostProfile().groups,
      container: { id: "a".repeat(64), operationId, preparedContainerSha256: "b".repeat(64) },
      socket: { path: "/private/socket", identity: { dev: "9", ino: "1" } }, records: m.files });
    const gate = { context: profiles.input.activation.context, check() {}, appendIntent() {}, revoke() {} };
    assert.equal(copyCaptureAttemptProfile(profiles.input.capture, gate).exec.operationId, operationId);
    assert.equal(copyActivationProfile(profiles.input.activation, gate).context.t0MonotonicNs, "1000");
    assert.equal(copyPlacementProfile(profiles.input.placement).clockPolicy, "monotonic_offsets");
    const launched = profiles.input.capture.launcherProfile;
    const profileBytes = m.route(launched.hostPath).bytes;
    assert.equal(copyLaunchProfile(profileBytes, { sha256: launched.sha256, bytes: launched.bytes }).profile.program.argv[0], m.plan.image.nodePath);
    assert(!profiles.startup.guardProfile.path.startsWith(files.paths.input + "/"));
    assert(m.records.has(`${files.prefix}.guard.json`));
    await assert.rejects(files.writeInput("guard.json", Buffer.from("private guard")), { code: "LAB_PROTOCOL" });
  } finally { await handles.closeAll(); await m.close(); }
});

test("revoked case-file preparation performs no opening and later partial preservation stays separate", async () => {
  const m = await caseFilesModel(); const handles = new LabHandles();
  try {
    const owner = new LabCaseFiles(m.lab, m.plan, "A", { check() { throw new AcquisitionRecordError("LAB_STOPPED"); },
      command: m.command, handles, files: m.files, retirementFiles: m.files, filesystem: m.port });
    await assert.rejects(owner.prepare(), { code: "LAB_STOPPED" }); assert.deepEqual(m.calls, []);
    assert(m.records.has(`${owner.prefix}.files-partial.json`));
  } finally { await handles.closeAll(); await m.close(); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { automaticPublicationEnvironment, checkPublicationEnvironment, publicationEnvironmentSnapshot } from "../../../scripts/publication-control.mjs";
import { canonicalBytes, sha256 } from "../../../scripts/release-record-data.mjs";

function fixture() {
  const environment = { id: 81, name: "tabgrad-tag-publication", can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    protection_rules: [{ id: 82, type: "branch_policy" }] };
  const branches = [{ id: 83, name: "main", type: "branch" }];
  return { environment, branches };
}

test("automatic admission accepts only the native main-only branch rule without pending gates", () => {
  const f = fixture();
  assert.equal(automaticPublicationEnvironment(f.environment, f.branches), true);
  for (const mutate of [
    f => { f.environment.protection_rules = []; },
    f => { delete f.environment.protection_rules; },
    ...["required_reviewers", "wait_timer", "custom", "unknown", "branch_policy"].map(type =>
      f => { f.environment.protection_rules.push({ id: 84, type }); }),
    f => { f.environment.protection_rules = [null]; },
    f => { delete f.environment.can_admins_bypass; },
    f => { delete f.environment.deployment_branch_policy; },
    f => { f.environment.deployment_branch_policy.protected_branches = true; },
    f => { f.environment.deployment_branch_policy.custom_branch_policies = false; },
    f => { f.branches = []; },
    f => { f.branches.push({ id: 84, name: "other", type: "branch" }); },
    f => { f.branches[0].name = "*"; },
    f => { f.branches[0].type = "tag"; },
  ]) {
    const changed = structuredClone(f); mutate(changed);
    assert.equal(automaticPublicationEnvironment(changed.environment, changed.branches), false);
  }
});

test("native branch marker identity and configuration remain fully snapshot-bound", async () => {
  const f = fixture(), now = Date.parse("2026-11-15T12:00:00.000Z");
  const snapshot = sha256(canonicalBytes(publicationEnvironmentSnapshot(f.environment, f.branches)));
  const args = { plan: { window: { start: "2026-11-15T11:00:00.000Z", deadline: "2026-11-15T13:00:00.000Z" } },
    policy: { tagAdmission: true, environment: { id: "81", name: f.environment.name, snapshotSha256: snapshot },
      operationalEvidence: { expiresAt: "2026-11-15T14:00:00.000Z" } }, now,
    api: { request: async path => path.endsWith("page=1") ? { total_count: 1, branch_policies: f.branches } : f.environment } };
  await checkPublicationEnvironment(args);
  f.environment.protection_rules[0].id = 99;
  assert.equal(automaticPublicationEnvironment(f.environment, f.branches), true);
  await assert.rejects(checkPublicationEnvironment(args), { code: "PUBLICATION_PROTECTION_INVALID" });
  f.environment.protection_rules[0].id = 82;
  f.environment.protection_rules.push({ type: "wait_timer", wait_timer: 0 });
  args.policy.environment.snapshotSha256 = sha256(canonicalBytes(publicationEnvironmentSnapshot(f.environment, f.branches)));
  await assert.rejects(checkPublicationEnvironment(args), { code: "PUBLICATION_PROTECTION_INVALID" });
});

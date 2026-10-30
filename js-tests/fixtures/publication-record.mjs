import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicationPlanFixture } from "./publication.mjs";
import { canonicalBytes, sha256 } from "../../scripts/release-record-data.mjs";
import { releaseRecord, locationIdentity } from "../../scripts/release-record.mjs";

export async function publicationRecordFixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-publication-record-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const location = join(directory, "destination.git"); await mkdir(location);
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "init", "--bare", "--template=", location],
    { encoding: "utf8", env: { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(result.status, 0, result.stderr);
  const f = publicationPlanFixture();
  const config = { schemaVersion: 1, protocol: "file", ref: "refs/heads/release-control-fixture",
    location, root: null, writerPolicy: "", evidence: {} };
  const retain = async value => {
    const bytes = canonicalBytes(value), identity = sha256(bytes), path = join(directory, `${identity}.json`);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); config.evidence[identity] = path;
    return identity;
  };
  config.writerPolicy = await retain({ fixture: "trusted writer" });
  const priorEffects = await retain({ fixture: "no effects before enrollment" });
  f.publicationPlan.authority = await retain({ fixture: "opaque approval identity" });
  f.publicationPlan.owner = await retain({ fixture: "opaque responsible owner" });
  const locationHash = await retain({ location, ref: config.ref, protocol: config.protocol });
  assert.equal(locationHash, locationIdentity(config));
  const event = { type: "enroll", at: new Date(f.now).toISOString(), location: locationHash,
    writerPolicy: config.writerPolicy, priorEffects };
  const inputBytes = canonicalBytes({ schemaVersion: 1, event });
  const root = await releaseRecord({ command: "enroll", config, expectedHead: "absent", inputBytes,
    inspected: sha256(inputBytes), clock: () => f.now });
  config.root = root.root;
  const policy = { record: { location, root: root.root, protocol: config.protocol, ref: config.ref },
    writerPolicySha256: config.writerPolicy };
  const authorityObservation = { ...f.authority, authority: f.publicationPlan.authority, owner: f.publicationPlan.owner,
    writerPolicySha256: policy.writerPolicySha256, planSha256: sha256(canonicalBytes(f.publicationPlan)) };
  return { directory, config, policy, authorityObservation, expectedHead: root.head, plan: f.publicationPlan, clock: () => f.now,
    now: f.now };
}


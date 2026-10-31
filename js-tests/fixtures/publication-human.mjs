import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicationPlanFixture } from "./publication.mjs";
import { canonicalBytes, sha256 } from "../../scripts/release-record-data.mjs";
import { publicationAuthorityDocument, publicationCandidateIdentity, publicationEffects } from "../../scripts/publication-plan.mjs";

/** Admitted-input port for IPC tests; this fixture does not claim real Git truth. */
export async function humanPublicationFixture(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-human-ipc-test-"));
  const ownedDirectories = [], children = [];
  const stop = () => { for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };
  t.signal.addEventListener("abort", stop, { once: true });
  t.after(async () => {
    stop(); await Promise.all(children.map(value => value.closed));
    for (const directory of ownedDirectories) await rm(directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true }); t.signal.removeEventListener("abort", stop);
  });
  for (const name of ["input", "admission", "data", "proofs", "public-output"]) await mkdir(join(root, name));
  const { publicationPlan: plan, authority } = publicationPlanFixture();
  if (config.windowMs) plan.window.deadline = new Date(Date.now() + config.windowMs).toISOString();
  if (config.clientSha256) plan.publisher.clientSha256 = config.clientSha256;
  const archive = Buffer.from("synthetic-archive-not-published"), proof = Buffer.from('{"synthetic":"not-a-proof"}\n');
  plan.candidate.archiveSha512 = createHash("sha512").update(archive).digest("hex");
  plan.producer.verification.candidate.archiveSha512 = plan.candidate.archiveSha512;
  plan.producer.archiveProofSha256 = sha256(proof);
  authority.planSha256 = sha256(canonicalBytes(plan)); authority.window = structuredClone(plan.window);
  const handoff = { schemaVersion: 1, operation: plan.operation, planSha256: authority.planSha256,
    call: "b".repeat(64), effect: publicationEffects(plan)[0].identity, recordHead: "a".repeat(40) };
  const journal = { head: handoff.recordHead, checkpoint: { activeOperation: plan.operation, unresolvedCalls: 1, conflictingCalls: 0 },
    operations: [{ operation: plan.operation, closure: null, admission: { window: plan.window, owner: plan.owner,
      candidate: publicationCandidateIdentity(plan), authority: sha256(canonicalBytes(publicationAuthorityDocument(plan, authority))) },
      calls: [{ call: handoff.call, intent: { effect: handoff.effect }, outcome: "unknown", observations: 0 }] }] };
  const admission = { handoff, journal, authorityObservation: authority,
    candidate: { tarball: { path: "candidate.tgz", byteLength: archive.length } } };
  const reader = { schemaVersion: 1, scope: "example", username: "fixture-owner", namespaceVisibility: "qualified-owner",
    expiresAt: config.readerWindowMs ? new Date(Date.now() + config.readerWindowMs).toISOString() : plan.window.deadline,
    evidenceSha256: "f".repeat(64) };
  for (const [path, raw] of [["input/plan.json", canonicalBytes(plan)], ["admission/admission.json", canonicalBytes(admission)],
    ["data/candidate.tgz", archive], ["proofs/archive-proof.json", proof], ["reader.json", canonicalBytes(reader)],
    ["fixture.json", canonicalBytes(config)], ["synthetic.npmrc", Buffer.from("//registry.npmjs.org/:_authToken=fixture-only-not-a-credential\n")]]) {
    await writeFile(join(root, path), raw, { flag: "wx", mode: 0o600 });
  }
  const environment = { GH_TOKEN: "must-not-forward", GITHUB_TOKEN: "must-not-forward",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "must-not-forward", NODE_OPTIONS: "must-not-forward",
    TABGRAD_PUBLICATION_CLIENT: config.clientDirectory ?? "/fixture/client",
    TABGRAD_HUMAN_NPMRC: join(root, "synthetic.npmrc"), TABGRAD_HUMAN_READER: join(root, "reader.json"),
    TABGRAD_HUMAN_READER_SHA256: sha256(canonicalBytes(reader)) };
  let launched = 0;
  const launch = options => {
    launched++;
    const child = fork(fileURLToPath(new URL("./publication-human-client.mjs", import.meta.url)), [],
      { cwd: options.root, execPath: process.execPath, execArgv: [], env: options.environment, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    children.push({ child, closed: new Promise(resolve => child.once("close", resolve)) });
    const send = child.send.bind(child);
    child.send = (message, callback) => {
      if (message.kind === "start") ownedDirectories.push(message.directory);
      return send(message, callback);
    };
    return child;
  };
  return { root, plan, admission, environment, launch, ownedDirectories, get launched() { return launched; } };
}

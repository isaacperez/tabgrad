import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { recoveryFixture, retainRecoveryOriginal } from "../../fixtures/release-record-recovery.mjs";
import { canonicalBytes, recoveryApprovalComment, sha256 } from "../../../scripts/release-record-data.mjs";
import { releaseRecord } from "../../../scripts/release-record.mjs";
import { recoverReleaseRecord, checkRecoverySource } from "../../../scripts/release-record-recovery.mjs";
import { publicationGithub } from "../../../scripts/publication-github.mjs";

async function commandFixture(context) {
  const f = await recoveryFixture(context);
  f.comment = { id: 42, issue_url: "https://api.github.com/repos/example/project/issues/17", user: { id: 99, login: "maintainer", type: "User" },
    body: "", created_at: f.window.start, updated_at: f.window.start };
  f.rules = { main: { id: 11, enforcement: "active", bypass_actors: [], fixture: "main rules" },
    record: { id: 12, enforcement: "active", bypass_actors: [], fixture: "record rules" } };
  const oldPolicy = JSON.parse(await readFile(f.config.evidence[f.nextWriterPolicy]));
  f.nextWriterPolicy = await retainRecoveryOriginal(f, { ...oldPolicy,
    mainRulesSha256: sha256(canonicalBytes(f.rules.main)), recordRulesSha256: sha256(canonicalBytes(f.rules.record)) });
  f.decision.nextWriterPolicy = f.nextWriterPolicy;
  await retainRecoveryOriginal(f, f.decision);
  f.comment.body = recoveryApprovalComment(f.decision);
  f.qualificationBytes = canonicalBytes({ fixture: "separately admitted qualification original" });
  f.profile = { schemaVersion: 1, repository: "example/project", repositoryId: "5", ownerId: "6", issue: "17",
    maintainer: { id: "99", ownerSha256: f.plan.owner }, sourceRevision: "a".repeat(40),
    nodeVersion: process.version, nodeSha256: sha256(await readFile(process.execPath)), configSha256: sha256(canonicalBytes(f.config)),
    nextWriterPolicy: f.nextWriterPolicy, rules: { main: "11", record: "12" }, window: f.window,
    qualification: { sha256: sha256(f.qualificationBytes), expiresAt: f.window.deadline } };
  f.requests = [];
  f.permission = { permission: "admin", user: { id: 99, login: "maintainer" } };
  f.sourceChecks = 0;
  f.fetcher = async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, "Bearer synthetic-test-token");
    const route = url.pathname.replace("/repos/example/project", "");
    f.requests.push(route);
    await f.beforeResponse?.(route);
    const responses = { "": { id: 5, owner: { id: 6 }, full_name: "example/project", default_branch: "main", archived: false, disabled: false },
      "/git/ref/heads/main": { ref: "refs/heads/main", object: { type: "commit", sha: f.profile.sourceRevision } },
      "/rulesets/11": f.rules.main, "/rulesets/12": f.rules.record, "/issues/comments/42": f.comment,
      "/collaborators/maintainer/permission": f.permission };
    assert.ok(Object.hasOwn(responses, route), route);
    return new Response(JSON.stringify(responses[route]), { status: 200 });
  };
  f.invoke = (command = "apply", options = {}) => {
    const profileBytes = canonicalBytes(f.profile), decisionBytes = canonicalBytes(f.decision);
    return recoverReleaseRecord({ command, profileBytes, profileSha256: sha256(profileBytes), config: f.config,
      decisionBytes, decisionSha256: sha256(decisionBytes), qualificationBytes: f.qualificationBytes,
      output: join(f.directory, `${command}-output`), commentId: "42", clock: f.recoveryClock,
      api: publicationGithub({ repository: "example/project", token: "synthetic-test-token", fetcher: f.fetcher, readOnly: true }),
      checkSource: async () => { f.sourceChecks++; }, ...options });
  };
  return f;
}

test("maintained command authenticates exact approval through bounded GET transport and real Git", async context => {
  const f = await commandFixture(context), oldHead = f.expectedHead;
  const preparation = await f.invoke("prepare");
  assert.equal(preparation.approvalComment, recoveryApprovalComment(f.decision));
  const result = await f.invoke();
  assert.equal(result.status, "confirmed"); assert.notEqual(result.head, oldHead);
  assert.equal(f.requests.filter(route => route === "/issues/comments/42").length, 3);
  assert.ok(f.sourceChecks > 3);
  const output = join(f.directory, "apply-output");
  const config = JSON.parse(await readFile(join(output, "next-config.json")));
  const replay = await releaseRecord({ command: "read", config, expectedHead: result.head, clock: f.recoveryClock });
  assert.equal(replay.checkpoint.unresolvedCalls, 1); assert.equal(replay.checkpoint.blockingUnresolvedCalls, 0);
  const names = await readdir(join(output, "public-evidence"));
  assert.equal(names.length, 2);
  const holder = JSON.parse(await readFile(config.evidence[replay.operations[0].retirement.approval]));
  assert.equal(holder.profileSha256, sha256(canonicalBytes(f.profile)));
  const original = JSON.parse(await readFile(join(output, "private", `${holder.commentSha256}.json`)));
  assert.deepEqual(original, f.comment);
  assert.equal(JSON.stringify(holder).includes("maintainer"), false);
  for (const name of names) {
    const raw = await readFile(join(output, "public-evidence", name));
    assert.equal(sha256(raw), name.slice(0, 64));
    assert.equal(raw.includes(Buffer.from("synthetic-test-token")), false);
    assert.equal(raw.includes(Buffer.from("example/project")), false);
  }
  // Same owned output cannot repeat an operation, even with unchanged arguments.
  await assert.rejects(f.invoke(), { code: "EEXIST" });
});

for (const [name, mutate, code] of [
  ["unrelated body", f => { f.comment.body = "approved"; }, "RECOVERY_APPROVAL_INVALID"],
  ["foreign issue", f => { f.comment.issue_url += "0"; }, "RECOVERY_APPROVAL_INVALID"],
  ["foreign actor", f => { f.comment.user.id++; }, "RECOVERY_APPROVAL_INVALID"],
  ["write-only collaborator", f => { f.permission.permission = "write"; }, "RECOVERY_MAINTAINER_REQUIRED"],
  ["wrong collaborator ID", f => { f.permission.user.id++; }, "RECOVERY_MAINTAINER_REQUIRED"],
  ["approval from old window", f => { f.comment.created_at = "2020-01-01T00:00:00Z"; }, "RECOVERY_APPROVAL_EXPIRED"],
  ["changed protection", f => { f.rules.main.enforcement = "disabled"; }, "RECOVERY_PROTECTION_CHANGED"],
  ["changed qualification", f => { f.qualificationBytes = Buffer.from("changed"); }, "RECOVERY_QUALIFICATION_CHANGED"],
]) test(`recovery command rejects ${name} before append`, async context => {
  const f = await commandFixture(context); mutate(f);
  let appends = 0;
  await assert.rejects(f.invoke("apply", { protocol: request => {
    appends += Number(request.command === "append"); return releaseRecord(request);
  } }), { code });
  assert.equal(appends, 0);
  const observed = await releaseRecord({ command: "read", config: f.config, expectedHead: f.expectedHead, clock: f.recoveryClock });
  assert.equal(observed.checkpoint.sequence, f.decision.sequence);
});

test("expiry during authenticated reads cannot reach the push", async context => {
  const f = await commandFixture(context);
  f.beforeResponse = route => {
    if (route === "/issues/comments/42" && f.requests.filter(value => value === route).length === 3) {
      f.recoveryNow = Date.parse(f.window.deadline);
    }
  };
  await assert.rejects(f.invoke(), { code: "RECOVERY_WINDOW_EXPIRED" });
  const observed = await releaseRecord({ command: "read", config: f.config, expectedHead: f.expectedHead, clock: f.recoveryClock });
  assert.equal(observed.checkpoint.sequence, f.decision.sequence);
});

test("denied provider and a source check failure preserve the old head", async context => {
  const f = await commandFixture(context);
  const denied = publicationGithub({ repository: "example/project", token: "synthetic", readOnly: true,
    fetcher: async () => new Response("denied", { status: 403 }) });
  await assert.rejects(f.invoke("apply", { api: denied }), { code: "PUBLICATION_GITHUB_RESPONSE" });
  await assert.rejects(f.invoke("prepare", { checkSource: async () => { throw Object.assign(new Error("synthetic"), { code: "RECOVERY_SOURCE_CHANGED" }); } }),
    { code: "RECOVERY_SOURCE_CHANGED" });
  assert.equal((await releaseRecord({ command: "read", config: f.config, expectedHead: f.expectedHead })).checkpoint.sequence,
    f.decision.sequence);
});

test("an edited but still matching approval cannot replace its frozen attribution before push", async context => {
  const f = await commandFixture(context);
  f.beforeResponse = route => {
    if (route === "/issues/comments/42" && f.requests.filter(value => value === route).length === 3) {
      f.recoveryNow++;
      f.comment.updated_at = new Date(f.recoveryNow).toISOString();
    }
  };
  await assert.rejects(f.invoke(), { code: "RECOVERY_APPROVAL_CHANGED" });
  assert.equal((await releaseRecord({ command: "read", config: f.config, expectedHead: f.expectedHead })).checkpoint.sequence,
    f.decision.sequence);
});

test("malformed provider JSON is not approval", async context => {
  const f = await commandFixture(context);
  await assert.rejects(f.invoke("apply", { api: publicationGithub({ repository: "example/project", token: "synthetic",
    readOnly: true, fetcher: async () => new Response("not json", { status: 200 }) }) }),
  { code: "PUBLICATION_GITHUB_REQUEST" });
});

for (const failFailure of [false, true]) test(`failed receipt conservation retains head and forbids repeat; failure file unavailable=${failFailure}`, async context => {
  const f = await commandFixture(context);
  const output = join(f.directory, "apply-output");
  let receipt;
  await assert.rejects(f.invoke("apply", { protocol: async request => {
    const result = await releaseRecord(request);
    if (request.command === "append") {
      receipt = result; await mkdir(join(output, "receipt.json"));
      if (failFailure) await mkdir(join(output, "failure.json"));
    }
    return result;
  } }), error => {
    assert.equal(error.code, "EEXIST"); assert.equal(error.receipt.head, receipt.head);
    assert.equal(error.conservationFailed === true, failFailure); return true;
  });
  if (!failFailure) {
    const failure = JSON.parse(await readFile(join(output, "failure.json")));
    assert.equal(failure.receipt.status, "confirmed");
  }
  const config = { ...structuredClone(f.config), writerPolicy: f.nextWriterPolicy };
  for (const name of await readdir(join(output, "public-evidence"))) config.evidence[name.slice(0, 64)] = join(output, "public-evidence", name);
  const replay = await releaseRecord({ command: "read", config, expectedHead: receipt.head });
  assert.equal(replay.checkpoint.sequence, f.decision.sequence + 1);
  await assert.rejects(f.invoke(), { code: "EEXIST" });
});

test("real source identity and CLI refuse an unrelated revision or incomplete invocation", async () => {
  await assert.rejects(checkRecoverySource({ sourceRevision: "0".repeat(40), nodeVersion: process.version,
    nodeSha256: sha256(await readFile(process.execPath)) }), { code: "RECOVERY_SOURCE_CHANGED" });
  const result = spawnSync(process.execPath, ["scripts/release-record-recovery.mjs", "apply"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { status: "failed", code: "COMMAND_INVALID", conservationFailed: false });
  assert.equal(result.stderr, "");
});

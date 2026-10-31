/** Explicit administrative recovery; importing this module has no service effect. */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { publicationGithub } from "./publication-github.mjs";
import { publicationFile } from "./publication-admission.mjs";
import { exactPublicationKeys } from "./publication-plan.mjs";
import { releaseRecord, locationIdentity, recorderEnvironment } from "./release-record.mjs";
import { canonicalBytes, digest, prepareRecoveryDecision, readCanonical, recoveryApprovalComment,
  requireRecord, sha256, validateRecoveryDecision, validateWriterRolePolicy } from "./release-record-data.mjs";

const identifier = /^[1-9][0-9]*$/;
const revision = /^[0-9a-f]{40}$/;
const checkout = fileURLToPath(new URL("..", import.meta.url));

function recoveryTime(profile, decision, clock) {
  const now = clock();
  requireRecord(Number.isFinite(now) && Date.parse(profile.window.start) <= now
    && now < Date.parse(profile.window.deadline) && now < Date.parse(profile.qualification.expiresAt)
    && decision.window.start === profile.window.start && decision.window.deadline === profile.window.deadline,
  "RECOVERY_WINDOW_EXPIRED");
  return now;
}

/** The expected digest is enrolled separately; this file cannot grant itself authority. */
export function admitRecoveryProfile(bytes, expectedSha256) {
  digest(expectedSha256);
  requireRecord(sha256(bytes) === expectedSha256, "RECOVERY_PROFILE_CHANGED");
  const value = readCanonical(bytes);
  requireRecord(exactPublicationKeys(value, ["schemaVersion", "repository", "repositoryId", "ownerId", "issue",
    "maintainer", "sourceRevision", "nodeVersion", "nodeSha256", "configSha256", "nextWriterPolicy", "rules",
    "qualification", "window"]) && value.schemaVersion === 1
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)
    && value.repository.split("/").every(part => part !== "." && part !== "..")
    && [value.repositoryId, value.ownerId, value.issue].every(id => typeof id === "string" && identifier.test(id))
    && revision.test(value.sourceRevision) && /^v22\.[0-9]+\.[0-9]+$/.test(value.nodeVersion)
    && exactPublicationKeys(value.maintainer, ["id", "ownerSha256"]) && identifier.test(value.maintainer.id)
    && exactPublicationKeys(value.rules, ["main", "record"]) && identifier.test(value.rules.main) && identifier.test(value.rules.record)
    && exactPublicationKeys(value.qualification, ["sha256", "expiresAt"])
    && exactPublicationKeys(value.window, ["start", "deadline"]), "RECOVERY_PROFILE_INVALID");
  for (const name of ["nodeSha256", "configSha256", "nextWriterPolicy"]) digest(value[name]);
  digest(value.maintainer.ownerSha256); digest(value.qualification.sha256);
  for (const date of [value.window.start, value.window.deadline, value.qualification.expiresAt]) {
    requireRecord(typeof date === "string" && Number.isFinite(Date.parse(date))
      && new Date(date).toISOString() === date, "RECOVERY_PROFILE_INVALID");
  }
  requireRecord(value.window.start < value.window.deadline
    && value.window.deadline <= value.qualification.expiresAt, "RECOVERY_PROFILE_INVALID");
  return value;
}

/** CLI default: execute only the separately admitted clean maintained checkout. */
function recoverySourceGit(args) {
  return spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", checkout, ...args],
    { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
      env: recorderEnvironment("file", dirname(checkout)) });
}

export async function checkRecoverySource(profile) {
  requireRecord(process.version === profile.nodeVersion
    && sha256(await readFile(process.execPath)) === profile.nodeSha256, "RECOVERY_TOOL_CHANGED");
  const head = recoverySourceGit(["rev-parse", "HEAD"]);
  const status = recoverySourceGit(["status", "--porcelain", "--untracked-files=all"]);
  requireRecord(head.status === 0 && head.stdout.trim() === profile.sourceRevision
    && status.status === 0 && status.stdout === "", "RECOVERY_SOURCE_CHANGED");
}

async function retainPrivate(directory, value) {
  const bytes = canonicalBytes(value), identity = sha256(bytes), path = join(directory, `${identity}.json`);
  try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST" || !(await readFile(path)).equals(bytes)) throw error; }
  return identity;
}

async function retainPublic(config, directory, value) {
  const identity = await retainPrivate(directory, value);
  const path = config.evidence[identity];
  if (path !== undefined) requireRecord((await readFile(path)).equals(canonicalBytes(value)), "EVIDENCE_CHANGED");
  else config.evidence[identity] = join(directory, `${identity}.json`);
  return identity;
}

async function currentRecoveryContext({ profile, decision, config, policy, api, checkSource, clock }) {
  recoveryTime(profile, decision, clock);
  await checkSource(profile);
  const repo = await api.request("");
  requireRecord(String(repo.id) === profile.repositoryId && String(repo.owner?.id) === profile.ownerId
    && repo.full_name === profile.repository && repo.default_branch === "main"
    && repo.archived === false && repo.disabled === false, "RECOVERY_REPOSITORY_CHANGED");
  const main = await api.request("/git/ref/heads/main");
  requireRecord(main.ref === "refs/heads/main" && main.object?.type === "commit"
    && main.object.sha === profile.sourceRevision, "RECOVERY_SOURCE_CHANGED");
  const rules = {};
  for (const name of ["main", "record"]) {
    rules[name] = await api.request(`/rulesets/${profile.rules[name]}`);
    requireRecord(String(rules[name].id) === profile.rules[name] && rules[name].enforcement === "active"
      && Array.isArray(rules[name].bypass_actors) && rules[name].bypass_actors.length === 0
      && sha256(canonicalBytes(rules[name])) === policy[`${name}RulesSha256`], "RECOVERY_PROTECTION_CHANGED");
  }
  requireRecord(config.protocol !== "https" || config.location === `https://github.com/${profile.repository}.git`,
    "RECOVERY_REPOSITORY_CHANGED");
  await checkSource(profile);
  recoveryTime(profile, decision, clock);
  return { repo, main, rules };
}

async function authenticatedRecovery(parameters, commentId, directory) {
  const { api, profile, decision, clock } = parameters;
  requireRecord(typeof commentId === "string" && identifier.test(commentId), "RECOVERY_COMMENT_REQUIRED");
  const context = await currentRecoveryContext(parameters);
  const comment = await api.request(`/issues/comments/${commentId}`);
  requireRecord(String(comment.id) === commentId
    && comment.issue_url === `https://api.github.com/repos/${profile.repository}/issues/${profile.issue}`
    && comment.body === recoveryApprovalComment(decision) && comment.user?.type === "User"
    && String(comment.user.id) === profile.maintainer.id && typeof comment.user.login === "string"
    && /^[A-Za-z0-9-]+$/.test(comment.user.login), "RECOVERY_APPROVAL_INVALID");
  const actor = { id: String(comment.user.id), ownerSha256: profile.maintainer.ownerSha256 };
  const permission = await api.request(`/collaborators/${encodeURIComponent(comment.user.login)}/permission`);
  requireRecord(String(permission.user?.id) === actor.id && permission.user?.login === comment.user.login
    && ["admin", "maintain"].includes(permission.permission), "RECOVERY_MAINTAINER_REQUIRED");
  const now = recoveryTime(profile, decision, clock);
  requireRecord(Number.isFinite(Date.parse(comment.created_at)) && Number.isFinite(Date.parse(comment.updated_at))
    && Date.parse(decision.window.start) <= Date.parse(comment.created_at)
    && Date.parse(comment.created_at) <= Date.parse(comment.updated_at) && Date.parse(comment.updated_at) <= now,
  "RECOVERY_APPROVAL_EXPIRED");
  // These are authenticated parsed responses, not preserved raw HTTP bytes.
  const commentSha256 = await retainPrivate(directory, comment);
  const actorSha256 = await retainPrivate(directory, actor);
  const permissionSha256 = await retainPrivate(directory, permission);
  await retainPrivate(directory, { kind: "authenticated-parsed-recovery-context", context, observedAt: new Date(now).toISOString() });
  await parameters.checkSource(profile);
  recoveryTime(profile, decision, clock);
  return { commentSha256, actorSha256, permissionSha256 };
}

async function frozenRecovery(parameters) {
  const { config, decision, protocol, clock } = parameters;
  const replay = await protocol({ command: "read", config, expectedHead: decision.expectedHead, clock });
  const expected = prepareRecoveryDecision(replay, decision);
  requireRecord(isDeepStrictEqual(expected, decision)
    && replay.operations.find(value => value.operation === decision.operation)?.admission.owner
      === parameters.profile.maintainer.ownerSha256, "RECOVERY_DECISION_CHANGED");
  return replay;
}

async function reauthenticateRecovery(parameters, context, event, attribution, commentId, directory) {
  requireRecord(context.head === parameters.decision.expectedHead && context.root === parameters.decision.root
    && isDeepStrictEqual(context.event, event), "RECOVERY_DECISION_CHANGED");
  const latest = await authenticatedRecovery(parameters, commentId, directory);
  requireRecord(isDeepStrictEqual(latest, attribution), "RECOVERY_APPROVAL_CHANGED");
  recoveryTime(parameters.profile, parameters.decision, parameters.clock);
}

function recoveryFailure(error) {
  return { status: "failed", code:
    typeof error.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(error.code) ? error.code : "LOCAL_FAILURE",
    ...(error.receipt ? { receipt: error.receipt } : {}), conservationFailed: error.conservationFailed === true };
}

/** One owned output, no service retry/reset; API/source ports are isolated test seams. */
export async function recoverReleaseRecord({ command, profileBytes, profileSha256, config, decisionBytes,
  decisionSha256, qualificationBytes, output, commentId, token, api, checkSource = checkRecoverySource,
  protocol = releaseRecord, clock = Date.now }) {
  requireRecord(["prepare", "apply"].includes(command), "COMMAND_INVALID");
  const profile = admitRecoveryProfile(profileBytes, profileSha256);
  requireRecord(sha256(canonicalBytes(config)) === profile.configSha256, "RECOVERY_CONFIG_CHANGED");
  digest(decisionSha256);
  requireRecord(sha256(decisionBytes) === decisionSha256, "RECOVERY_DECISION_CHANGED");
  const decision = validateRecoveryDecision(readCanonical(decisionBytes));
  requireRecord(profile.nextWriterPolicy === decision.nextWriterPolicy && config.root === decision.root
    && config.writerPolicy === decision.previousWriterPolicy, "RECOVERY_POLICY_CHANGED");
  requireRecord(sha256(qualificationBytes) === profile.qualification.sha256, "RECOVERY_QUALIFICATION_CHANGED");
  const policy = validateWriterRolePolicy(readCanonical(await publicationFile(config.evidence[decision.nextWriterPolicy], 65536)),
    locationIdentity(config));
  recoveryTime(profile, decision, clock);
  const parameters = { profile, decision, config: structuredClone(config), policy, checkSource, clock, protocol,
    api: api ?? publicationGithub({ repository: profile.repository, token, readOnly: true }) };
  // Existing output means this attempt already started; inspect it instead of retrying.
  await mkdir(output, { mode: 0o700 });
  const privateDirectory = join(output, "private"), publicDirectory = join(output, "public-evidence");
  await mkdir(privateDirectory, { mode: 0o700 }); await mkdir(publicDirectory, { mode: 0o700 });
  let attemptedReceipt;
  try {
    await writeFile(join(privateDirectory, "profile.json"), profileBytes, { flag: "wx", mode: 0o600 });
    await writeFile(join(privateDirectory, "qualification-original"), qualificationBytes, { flag: "wx", mode: 0o600 });
    await writeFile(join(output, "decision.json"), decisionBytes, { flag: "wx", mode: 0o600 });
    await currentRecoveryContext(parameters);
    await frozenRecovery(parameters);
    if (command === "prepare") {
      const receipt = { status: "prepared", decisionSha256, approvalComment: recoveryApprovalComment(decision) };
      await retainPrivate(privateDirectory, receipt);
      return receipt;
    }
    const attribution = await authenticatedRecovery(parameters, commentId, privateDirectory);
    const at = new Date(clock()).toISOString();
    const approval = await retainPublic(parameters.config, publicDirectory, { schemaVersion: 1,
      kind: "authenticated-recovery-comment", decisionSha256, profileSha256, ...attribution,
      sourceRevision: profile.sourceRevision, observedAt: at, expiresAt: decision.window.deadline });
    const event = { type: "handoff", at, decision, approval };
    await retainPublic(parameters.config, publicDirectory, decision);
    const inputBytes = canonicalBytes({ schemaVersion: 2, event });
    const receipt = await protocol({ command: "append", config: parameters.config, expectedHead: decision.expectedHead,
      inputBytes, inspected: sha256(inputBytes), clock,
      authenticateRecovery: context => reauthenticateRecovery(parameters, context, event, attribution, commentId, privateDirectory) });
    attemptedReceipt = receipt;
    await writeFile(join(output, "receipt.json"), canonicalBytes(receipt), { flag: "wx", mode: 0o600 });
    requireRecord(receipt.status === "confirmed", "WRITE_UNCONFIRMED");
    const nextConfig = { ...parameters.config, writerPolicy: decision.nextWriterPolicy };
    await writeFile(join(output, "next-config.json"), canonicalBytes(nextConfig), { flag: "wx", mode: 0o600 });
    return receipt;
  } catch (error) {
    error.receipt ??= attemptedReceipt;
    try { await writeFile(join(output, "failure.json"), canonicalBytes(recoveryFailure(error)), { flag: "wx", mode: 0o600 }); }
    catch (cause) { error.conservationFailed = true; error.conservationCause = cause; }
    throw error;
  }
}

async function main() {
  try {
    const [command, ...arguments_] = process.argv.slice(2), options = {};
    for (let i = 0; i < arguments_.length; i += 2) {
      const name = arguments_[i];
      requireRecord(["--profile", "--profile-sha256", "--config", "--decision", "--decision-sha256",
        "--qualification", "--output", "--comment"].includes(name) && !(name in options)
        && typeof arguments_[i + 1] === "string", "COMMAND_INVALID");
      options[name] = arguments_[i + 1];
    }
    requireRecord(Object.keys(options).length === (command === "apply" ? 8 : 7)
      && (command === "apply" || options["--comment"] === undefined), "COMMAND_INVALID");
    const receipt = await recoverReleaseRecord({ command,
      profileBytes: await publicationFile(options["--profile"], 65536), profileSha256: options["--profile-sha256"],
      config: readCanonical(await publicationFile(options["--config"], 4 * 1024 * 1024)),
      decisionBytes: await publicationFile(options["--decision"], 65536), decisionSha256: options["--decision-sha256"],
      qualificationBytes: await publicationFile(options["--qualification"], 65536),
      output: resolve(options["--output"]), commentId: options["--comment"], token: process.env.GH_TOKEN });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(recoveryFailure(error))}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

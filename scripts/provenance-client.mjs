import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

export const qualifiedProvenanceClient = "2.102.0";

/** Bounded public diagnostic. Raw client output/cause is private evidence. */
export class ProvenanceError extends Error {
  constructor(code, message) { super(message); this.name = "ProvenanceError"; this.code = code; }
}

export function requireProvenance(condition, code, message) {
  if (!condition) throw new ProvenanceError(code, message);
}

export function provenanceDigest(bytes, algorithm = "sha256") {
  return createHash(algorithm).update(bytes).digest("hex");
}

/** The offline verifier gets no ambient GitHub, proxy, Node or Git identity. */
export function provenanceEnvironment(directory, input = process.env) {
  const environment = {};
  for (const key of ["SYSTEMROOT", "WINDIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"]) {
    if (typeof input[key] === "string") environment[key] = input[key];
  }
  return { ...environment, HOME: directory, USERPROFILE: directory,
    XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"),
    GH_CONFIG_DIR: join(directory, "gh"), GH_HOST: "github.com", GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(directory, "empty-gitconfig") };
}

/** Run one owned client; timeout/output bounds cover stdout and stderr together. */
export async function runProvenanceClient(client, arguments_, { directory, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn(client, arguments_, { cwd: directory,
      env: provenanceEnvironment(directory), stdio: ["ignore", "pipe", "pipe"] });
    const output = []; const diagnostics = [];
    let length = 0; let failure;
    const timer = setTimeout(() => {
      failure ??= new ProvenanceError("CLIENT_TIMEOUT", "Offline provenance verification exceeded its deadline.");
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", cause => {
      failure ??= new ProvenanceError("CLIENT_FAILED", "The offline provenance client could not run.");
      failure.cause = cause;
    });
    child.stdout.on("data", chunk => {
      length += chunk.length;
      if (length > maxOutputBytes) {
        failure ??= new ProvenanceError("CLIENT_OUTPUT_LIMIT", "Offline provenance output exceeded its bound.");
        child.kill("SIGKILL");
      } else output.push(chunk);
    });
    child.stderr.on("data", chunk => {
      length += chunk.length;
      if (length > maxOutputBytes) {
        failure ??= new ProvenanceError("CLIENT_OUTPUT_LIMIT", "Offline provenance output exceeded its bound.");
        child.kill("SIGKILL");
      } else diagnostics.push(chunk);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      if (status !== 0) failure ??= new ProvenanceError("CLIENT_REJECTED", "The offline provenance client rejected the evidence.");
      if (failure !== undefined) {
        failure.privateClientEvidence = { status, signal, stdout: Buffer.concat(output).toString("utf8"),
          stderr: Buffer.concat(diagnostics).toString("utf8") };
        reject(failure);
      } else resolve(Buffer.concat(output).toString("utf8"));
    });
  });
}

/** Identify the admitted binary, not a PATH alias or a version string alone. */
export async function identifyProvenanceClient(input, limits, directory) {
  requireProvenance(input.version === qualifiedProvenanceClient, "CLIENT_UNQUALIFIED", "The selected provenance client version is not qualified.");
  const path = await realpath(input.path);
  const digest = provenanceDigest(await readFile(path));
  requireProvenance(digest === input.sha256, "CLIENT_MISMATCH", "The provenance client differs from its admitted identity.");
  const version = await runProvenanceClient(path, ["--version"], { ...limits, directory });
  requireProvenance(version.split("\n")[0].startsWith(`gh version ${qualifiedProvenanceClient} (`),
    "CLIENT_MISMATCH", "The provenance client reports a different version.");
  return { path, sha256: digest, version: qualifiedProvenanceClient };
}

/** Actual gh, original owned inputs, explicit offline trust and exact identity. */
export async function verifyProvenanceBundle(client, { artifact, bundle, trustRoot, algorithm, identity, limits, directory }) {
  const output = await runProvenanceClient(client.path, ["attestation", "verify", artifact,
    "--hostname", "github.com", "--bundle", bundle, "--custom-trusted-root", trustRoot,
    "--repo", identity.repository, "--digest-alg", algorithm,
    "--cert-identity", identity.signerUri, "--cert-oidc-issuer", "https://token.actions.githubusercontent.com",
    "--source-digest", identity.sourceRevision, "--source-ref", identity.sourceRef,
    "--signer-digest", identity.signerRevision, "--deny-self-hosted-runners", "--format", "json"],
  { ...limits, directory });
  let results;
  try { results = JSON.parse(output); }
  catch { throw new ProvenanceError("CLIENT_RESULT_INVALID", "The provenance client returned invalid JSON."); }
  requireProvenance(Array.isArray(results) && results.length === 1 && results[0]?.verificationResult !== null
    && typeof results[0]?.verificationResult === "object" && !Array.isArray(results[0].verificationResult),
    "CLIENT_RESULT_INVALID", "Expected exactly one verified provenance result.");
  return results[0].verificationResult;
}

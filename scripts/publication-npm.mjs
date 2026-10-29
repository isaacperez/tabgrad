import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { publicationEnvironment, runPublicationProcess } from "./publication-client.mjs";
import { exactPublicationKeys, requirePublication } from "./publication-plan.mjs";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";

/** Resolve every package-level publication override before recording a write intent. */
export function admitNpmManifest(manifest, plan) {
  requirePublication(manifest?.name === plan.candidate.name && manifest.version === plan.candidate.version
    && manifest.private !== true, "PUBLICATION_MANIFEST_INVALID");
  const config = manifest.publishConfig ?? {};
  requirePublication(config !== null && typeof config === "object" && !Array.isArray(config)
    && Object.keys(config).every(key => ["registry", "access", "tag"].includes(key))
    && (config.registry === undefined || config.registry === plan.npm.registry)
    && (config.access === undefined || config.access === plan.npm.access)
    && (config.tag === undefined || config.tag === plan.npm.channel), "PUBLICATION_NPM_OVERRIDE");
}

/** Own one private role's config. Never pass this object to an evidence writer. */
export async function prepareNpmRole({ directory, registry, authentication }) {
  requirePublication(typeof registry === "string"
    && ["oidc", "human", "fixture", "fixture-oidc"].includes(authentication?.kind), "PUBLICATION_NPM_AUTHENTICATION");
  const userconfig = join(directory, "publication.npmrc");
  const globalconfig = join(directory, "global.npmrc");
  let environment = publicationEnvironment(directory);
  let config = "";
  if (authentication.kind.startsWith("fixture")) {
    const url = new URL(registry);
    requirePublication(url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/"
      && url.username === "" && url.password === "", "PUBLICATION_FIXTURE_DESTINATION");
    if (authentication.kind === "fixture") config = `//${url.host}/:_authToken=fixture-only-not-a-credential\n`;
    else environment = { ...environment, GITHUB_ACTIONS: "true", CI: "true",
      ACTIONS_ID_TOKEN_REQUEST_URL: `${registry}fixture-id-token`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request-not-a-credential" };
  } else {
    requirePublication(registry === "https://registry.npmjs.org/", "PUBLICATION_NPM_DESTINATION");
    if (authentication.kind === "human") {
      // The private, explicitly selected interactive login belongs to the human;
      // it is never discovered through HOME, inherited npm config or CI secrets.
      requirePublication(typeof authentication.userconfig === "string" && isAbsolute(authentication.userconfig),
        "PUBLICATION_NPM_AUTHENTICATION");
      const stat = await lstat(authentication.userconfig);
      requirePublication(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384 && (stat.mode & 0o077) === 0,
        "PUBLICATION_NPM_AUTHENTICATION");
      config = await readFile(authentication.userconfig, "utf8");
      const lines = config.split(/\r?\n/).filter(line => line.trim() !== "");
      requirePublication(lines.length === 1 && /^\/\/registry\.npmjs\.org\/:_authToken=[A-Za-z0-9_.-]+$/.test(lines[0]),
        "PUBLICATION_NPM_AUTHENTICATION");
    } else {
      const input = authentication.environment;
      requirePublication(input?.GITHUB_ACTIONS === "true"
        && typeof input.ACTIONS_ID_TOKEN_REQUEST_TOKEN === "string" && input.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 0
        && typeof input.ACTIONS_ID_TOKEN_REQUEST_URL === "string"
        && new URL(input.ACTIONS_ID_TOKEN_REQUEST_URL).protocol === "https:", "PUBLICATION_NPM_AUTHENTICATION");
      environment = { ...environment, GITHUB_ACTIONS: "true", CI: "true",
        ACTIONS_ID_TOKEN_REQUEST_URL: input.ACTIONS_ID_TOKEN_REQUEST_URL,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: input.ACTIONS_ID_TOKEN_REQUEST_TOKEN };
    }
  }
  // Stop npm's project-prefix search inside this owned directory. The target
  // archive's own manifest is independently admitted by admitNpmManifest.
  await writeFile(join(directory, "package.json"), '{"name":"tabgrad-publication-role","version":"0.0.0","private":true}\n',
    { flag: "wx", mode: 0o600 });
  await writeFile(userconfig, config, { flag: "wx", mode: 0o600 });
  await writeFile(globalconfig, "", { flag: "wx", mode: 0o600 });
  return { directory, environment, authentication: authentication.kind,
    arguments: ["--registry", registry, "--ignore-scripts", "--json", "--userconfig", userconfig, "--globalconfig", globalconfig,
    "--cache", join(directory, "cache"), "--fetch-retries=0", "--fetch-timeout=30000",
    "--update-notifier=false", "--dry-run=false", "--workspaces=false"] };
}

/** Exact archive + original proof, with no implicit workspace or provenance mode. */
export async function publishNpmArchive({ client, archive, proof, directory, registry, channel,
  authentication, role, timeoutMs = 120000, maxOutputBytes = 1024 * 1024, signal }) {
  try {
    requirePublication(typeof channel === "string" && /^[a-z][a-z0-9._-]*$/.test(channel), "PUBLICATION_NPM_CHANNEL");
    role ??= await prepareNpmRole({ directory, registry, authentication });
    return await runPublicationProcess(client.executable, [client.npmEntry, "publish", archive,
      "--access", "public", "--tag", channel, "--provenance-file", proof, ...role.arguments], {
      directory: role.directory, environment: role.environment, timeoutMs, maxOutputBytes,
      interactive: role.authentication === "human", signal });
  } catch (error) { error.dispatched ??= false; throw error; }
}

/**
 * Human bootstrap additionally requires a separately qualified namespace reader.
 * Public 404 alone is never accepted. The admitted profile names the actual
 * authenticated organization owner; source fixtures cannot qualify that premise.
 */
export async function inspectBootstrapNamespace({ client, role, plan, reader, expectedReaderSha256, clock = Date.now, signal }) {
  const scope = /^@([a-z0-9][a-z0-9._-]*)\//.exec(plan.candidate.name)?.[1];
  requirePublication(["human", "fixture"].includes(role.authentication) && scope
    && exactPublicationKeys(reader, ["schemaVersion", "scope", "username", "namespaceVisibility", "expiresAt", "evidenceSha256"])
    && sha256(canonicalBytes(reader)) === expectedReaderSha256 && reader.schemaVersion === 1
    && typeof reader.evidenceSha256 === "string" && /^[0-9a-f]{64}$/.test(reader.evidenceSha256)
    && reader.scope === scope && typeof reader.username === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(reader.username)
    && reader.namespaceVisibility === "qualified-owner" && typeof reader.expiresAt === "string"
    && Number.isFinite(Date.parse(reader.expiresAt)) && new Date(reader.expiresAt).toISOString() === reader.expiresAt
    && clock() < Date.parse(reader.expiresAt),
  "PUBLICATION_BOOTSTRAP_VISIBILITY_UNQUALIFIED");
  const query = async arguments_ => runPublicationProcess(client.executable, [client.npmEntry, ...arguments_, ...role.arguments],
    { directory: role.directory, environment: role.environment, timeoutMs: 45000, maxOutputBytes: 1024 * 1024, signal });
  const who = JSON.parse((await query(["whoami"])).stdout);
  const members = JSON.parse((await query(["org", "ls", scope])).stdout);
  requirePublication(who === reader.username && members[reader.username] === "owner", "PUBLICATION_BOOTSTRAP_OWNER_CHANGED");
  let result, failure;
  try { result = await query(["view", plan.candidate.name]); } catch (error) { failure = error; }
  let errorCode;
  try { errorCode = JSON.parse(failure?.privateClientEvidence?.stdout).error.code; } catch { /* Unknown response stays closed. */ }
  requirePublication(result === undefined && failure?.code === "PUBLICATION_CLIENT_REJECTED" && errorCode === "E404",
    "PUBLICATION_BOOTSTRAP_PACKAGE_NOT_ABSENT");
  requirePublication(clock() < Date.parse(reader.expiresAt), "PUBLICATION_BOOTSTRAP_READER_EXPIRED");
  return { schemaVersion: 1, status: "passed", qualifiedReaderSha256: expectedReaderSha256,
    observed: "authenticated-qualified-owner-package-absent" };
}

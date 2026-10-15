import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PackageArtifactError, packageArchiveIdentity, stagePackageArchive, validatePackageEvidence, verifyPackageDirectory } from "./package-artifact.mjs";
import { downloadRegistryArchive, registryEndpoint as endpoint, registryTransport } from "./package-registry-transport.mjs";

const qualifiedNpmVersion = "11.1.0";

function requireRegistry(condition, code, message) {
  if (!condition) throw new PackageArtifactError(code, message);
}

/** Validate/snapshot private JSON configuration; return normalized explicit origins. */
export function validateRegistryPlan(input) {
  const plan = structuredClone(input);
  requireRegistry(plan !== null && typeof plan === "object" && !Array.isArray(plan)
    && Object.keys(plan).sort().join() === "allowedOrigins,channel,clientTimeoutMs,maxClientOutputBytes,registry,schemaVersion"
    && plan.schemaVersion === 1 && typeof plan.registry === "string"
    && typeof plan.channel === "string" && /^[a-z][a-z0-9._-]*$/.test(plan.channel)
    && Number.isSafeInteger(plan.clientTimeoutMs) && plan.clientTimeoutMs > 0 && plan.clientTimeoutMs <= 2147483647
    && Number.isSafeInteger(plan.maxClientOutputBytes) && plan.maxClientOutputBytes > 0
    && Array.isArray(plan.allowedOrigins) && plan.allowedOrigins.length > 0,
  "REGISTRY_PLAN_INVALID", "Registry plan fields or finite client bounds are invalid.");
  const registry = endpoint(plan.registry);
  requireRegistry(registry.href.endsWith("/"), "REGISTRY_PLAN_INVALID", "Registry base must end with a slash.");
  const origins = plan.allowedOrigins.map(value => {
    requireRegistry(typeof value === "string", "REGISTRY_PLAN_INVALID", "Allowed origins must be strings.");
    return endpoint(value, true).origin;
  });
  requireRegistry(new Set(origins).size === origins.length && origins.includes(registry.origin),
    "REGISTRY_PLAN_INVALID", "Registry origin must be admitted exactly once.");
  return { ...plan, registry: registry.href, allowedOrigins: origins };
}

/** Explicit environment; no npm, Git, SSH, Node injection or credential fallback. */
export function registryEnvironment(directory, input = process.env) {
  const result = {};
  for (const key of ["PATH", "SYSTEMROOT", "WINDIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"]) {
    if (input[key] !== undefined) result[key] = input[key];
  }
  return { ...result, HOME: join(directory, "home"), USERPROFILE: join(directory, "home"),
    XDG_CONFIG_HOME: join(directory, "home"), NODE_DISABLE_COMPILE_CACHE: "1", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(directory, "empty-gitconfig"), GIT_ALLOW_PROTOCOL: "", NO_PROXY: "", no_proxy: "" };
}

async function npmClient(arguments_, context, online = false) {
  const { directory, environment, plan, transport } = context;
  const common = ["--json", "--ignore-scripts", "--bin-links=false", "--audit=false", "--fund=false",
    "--update-notifier=false", "--global=false", "--workspaces=false", "--registry", plan.registry,
    "--replace-registry-host=never", "--userconfig", join(directory, "npmrc"),
    "--globalconfig", join(directory, "global-npmrc"), "--cache", join(directory, "cache"),
    "--fetch-retries=0", `--fetch-timeout=${plan.clientTimeoutMs}`, "--noproxy=",
    ...(online ? ["--prefer-online", "--proxy", transport.url, "--https-proxy", transport.url] : ["--offline"])];
  const stdout = [], stderr = [];
  let outputBytes = 0, timedOut = false, overflow = false;
  const child = spawn("npm", [...arguments_, ...common], { cwd: context.application, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, plan.clientTimeoutMs);
  const output = (bytes, stream) => {
    outputBytes += bytes.length;
    if (outputBytes > plan.maxClientOutputBytes) { overflow = true; child.kill("SIGKILL"); }
    else (stream === "stdout" ? stdout : stderr).push(bytes);
  };
  child.stdout.on("data", bytes => output(bytes, "stdout"));
  child.stderr.on("data", bytes => output(bytes, "stderr"));
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  } catch (cause) {
    const error = new PackageArtifactError("REGISTRY_CLIENT_FAILED", "The prepared npm client could not run.");
    error.cause = cause; throw error;
  } finally { clearTimeout(timer); }
  transport.assertAllowed();
  if (result.code !== 0 || timedOut || overflow) {
    const error = new PackageArtifactError(timedOut ? "REGISTRY_CLIENT_TIMEOUT" : overflow ? "REGISTRY_CLIENT_OUTPUT_LIMIT" : "REGISTRY_CLIENT_FAILED",
      "The isolated npm client did not complete successfully.");
    error.exitCode = result.code; error.signal = result.signal;
    error.cause = { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
    throw error;
  }
  return Buffer.concat(stdout).toString("utf8");
}

function jsonResult(text) {
  try { return JSON.parse(text); }
  catch { throw new PackageArtifactError("REGISTRY_RESPONSE_INVALID", "The npm client did not return valid JSON."); }
}

function registryManifest(result, expected, plan) {
  requireRegistry(result !== null && typeof result === "object" && !Array.isArray(result)
    && result.name === expected.name && result.version === expected.version
    && result["dist.integrity"] === expected.tarball.integrity,
  "REGISTRY_METADATA_MISMATCH", "Registry metadata differs from the admitted exact package identity.");
  const tarball = endpoint(result["dist.tarball"], false, "REGISTRY_ENDPOINT_REJECTED");
  requireRegistry(plan.allowedOrigins.includes(tarball.origin), "REGISTRY_ENDPOINT_REJECTED", "Registry archive origin is not admitted.");
  requireRegistry(result["dist-tags"]?.[plan.channel] === expected.version,
    "REGISTRY_CHANNEL_MISMATCH", "The selected registry channel does not identify the admitted version.");
  requireRegistry(["dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"].every(key =>
    result[key] === undefined || (result[key] !== null && typeof result[key] === "object" && Object.keys(result[key]).length === 0)),
  "REGISTRY_DEPENDENCIES_REJECTED", "This qualification profile admits no registry dependency graph.");
  return tarball.href;
}

function lockDocument(expected, resolved) {
  const root = { name: "tabgrad-registry-consumer", version: "0.0.0", dependencies: { [expected.name]: expected.version } };
  return { name: root.name, version: root.version, lockfileVersion: 3, requires: true,
    packages: { "": root, [`node_modules/${expected.name}`]: { version: expected.version, resolved, integrity: expected.tarball.integrity } } };
}

function verifyLock(lock, expected, resolved) {
  const packages = lock?.packages;
  const entry = packages?.[`node_modules/${expected.name}`];
  requireRegistry(lock?.lockfileVersion === 3 && packages && Object.keys(packages).length === 2
    && Object.keys(packages[""]?.dependencies ?? {}).length === 1 && packages[""].dependencies[expected.name] === expected.version
    && entry?.version === expected.version && entry.resolved === resolved && entry.integrity === expected.tarball.integrity,
  "REGISTRY_INSTALL_MISMATCH", "The npm installation lock differs from the admitted registry resolution.");
}

function registryCacheArchive(directory, integrity) {
  requireRegistry(/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity), "EVIDENCE_INVALID", "Registry archive identity requires one canonical SHA-512 integrity.");
  const bytes = Buffer.from(integrity.slice(7), "base64");
  requireRegistry(bytes.length === 64 && bytes.toString("base64") === integrity.slice(7),
    "EVIDENCE_INVALID", "Registry archive integrity is not canonical.");
  const hex = bytes.toString("hex");
  // Qualified npm 11.1.0: pacote consumes cacache content-v2 by this SHA-512
  // address. Do not import private global packages or assume another layout.
  return join(directory, "cache/_cacache/content-v2/sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

async function verifyRegistryCache(path, expected) {
  let bytes;
  try { bytes = await readFile(path); }
  catch (cause) {
    const error = new PackageArtifactError("REGISTRY_CACHE_UNQUALIFIED", "The selected npm client did not retain the required content-addressed archive.");
    error.cause = cause; throw error;
  }
  const archive = packageArchiveIdentity(bytes);
  requireRegistry(archive.byteLength === expected.tarball.byteLength && archive.sha256 === expected.tarball.sha256
    && archive.integrity === expected.tarball.integrity, "ARCHIVE_MISMATCH", "The npm cache archive differs from the admitted bytes.");
  return archive;
}

/**
 * Resolve online, then install the named registry version from checked cache/lock.
 * The caller owns close() and must retain required originals before it. registry
 * is public-safe; privateRegistryEvidence, paths and error causes are private.
 * Failure removes owned state and retains safe progress on error.registry.
 */
export async function createRegistryPackageApplication({ registryPlan, expected: input }) {
  const expected = validatePackageEvidence(input);
  const plan = validateRegistryPlan(registryPlan);
  const number = "(?:0|[1-9][0-9]*)";
  const identifier = `(?:${number}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
  requireRegistry(new RegExp(`^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`).test(expected.version),
    "EVIDENCE_INVALID", "Registry qualification requires an exact semantic version, not a range or tag.");
  registryCacheArchive("", expected.tarball.integrity);
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-registry-"));
  const observation = { status: "failed", producerAuthentication: "unqualified", releaseAdmission: "unqualified", checks: [],
    planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"), channel: plan.channel };
  const privateRegistryEvidence = { plan };
  let transport, phase = "client-preparation";
  try {
    const application = join(directory, "application");
    await mkdir(application); await mkdir(join(directory, "home"));
    for (const file of ["npmrc", "global-npmrc", "empty-gitconfig"]) await writeFile(join(directory, file), "");
    await writeFile(join(application, "package.json"), '{"private":true,"type":"module"}\n');
    transport = await registryTransport(plan.allowedOrigins, plan.clientTimeoutMs);
    observation.transport = transport.observations;
    const context = { directory, application, plan, transport, environment: registryEnvironment(directory) };
    const selectedNode = (await readFile(new URL("../.node-version", import.meta.url), "utf8")).trim();
    requireRegistry(process.version === `v${selectedNode}`, "REGISTRY_CLIENT_UNQUALIFIED", "Registry qualification requires the repository-selected Node.js runtime.");
    observation.npm = (await npmClient(["--version"], context)).trim();
    const selectedNpm = JSON.parse(await readFile(new URL("../package.json", import.meta.url))).packageManager;
    requireRegistry(`npm@${observation.npm}` === selectedNpm && observation.npm === qualifiedNpmVersion,
      "REGISTRY_CLIENT_UNQUALIFIED", "The npm client must match the repository selection and this qualified cache profile.");
    phase = "registry-metadata";
    const fields = ["name", "version", "dist.tarball", "dist.integrity", "dist-tags", "dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"];
    const metadataText = await npmClient(["view", `${expected.name}@${expected.version}`, ...fields], context, true);
    privateRegistryEvidence.metadataText = metadataText;
    observation.metadataObservedAt = new Date().toISOString();
    const resolved = registryManifest(jsonResult(metadataText), expected, plan);
    privateRegistryEvidence.resolved = resolved;
    observation.metadataSha256 = createHash("sha256").update(metadataText).digest("hex");
    observation.resolvedSha256 = createHash("sha256").update(resolved).digest("hex");
    observation.checks.push("exact-registry-metadata", "channel", "dependency-boundary");
    phase = "registry-archive";
    const downloaded = await downloadRegistryArchive(resolved, plan, expected.tarball.byteLength);
    observation.download = downloaded.observation;
    privateRegistryEvidence.downloadURLs = downloaded.urls;
    const archivePath = join(directory, "download.tgz");
    await writeFile(archivePath, downloaded.bytes, { flag: "wx", mode: 0o600 });
    await mkdir(join(directory, "admitted"));
    const staged = await stagePackageArchive(archivePath, expected, join(directory, "admitted"));
    observation.archive = staged.archive;
    observation.checks.push("downloaded-archive-identity", "archive-structure", "metadata-and-source");
    phase = "approved-cache-population";
    await npmClient(["cache", "add", staged.tarball], context);
    const cachedArchive = registryCacheArchive(directory, expected.tarball.integrity);
    await verifyRegistryCache(cachedArchive, expected);
    observation.checks.push("approved-cache-population");
    // The lock pins observed registry resolution + admitted integrity. npm still
    // installs name@version; it never installs this archive's local pathname.
    const lock = lockDocument(expected, resolved);
    await writeFile(join(application, "package.json"), `${JSON.stringify({ ...lock.packages[""], private: true, type: "module" })}\n`);
    await writeFile(join(application, "package-lock.json"), `${JSON.stringify(lock)}\n`);
    phase = "registry-installation";
    await npmClient(["install", `${expected.name}@${expected.version}`, "--save-exact", "--package-lock=true"], context);
    verifyLock(jsonResult(await readFile(join(application, "package-lock.json"), "utf8")), expected, resolved);
    const packageDirectory = join(application, "node_modules", ...expected.name.split("/"));
    await verifyPackageDirectory(packageDirectory, expected.files);
    // Recheck the actual content-addressed object npm consumed, rather than
    // an independently hashed pathname or another dynamic registry resolution.
    phase = "consumed-cache-archive";
    observation.consumedArchive = await verifyRegistryCache(cachedArchive, expected);
    observation.checks.push("named-registry-installation", "consumed-archive-integrity", "installed-inventory");
    transport.assertAllowed(); await transport.close(); transport = undefined;
    observation.status = "passed";
    return { directory, application, packageDirectory, tarball: staged.tarball, metadata: staged.metadata, evidence: staged.expected,
      packed: { files: expected.files }, registry: observation, privateRegistryEvidence,
      installationProcessOptions: { environment: context.environment, timeout: plan.clientTimeoutMs, maxBuffer: plan.maxClientOutputBytes },
      async close() { await rm(directory, { recursive: true, force: true }); } };
  } catch (error) {
    if (error.registryDownload !== undefined) observation.download = error.registryDownload;
    if (error.registryDownloadURLs !== undefined) privateRegistryEvidence.downloadURLs = error.registryDownloadURLs;
    error.registry = { ...observation, phase };
    error.privateRegistryEvidence = privateRegistryEvidence;
    if (transport !== undefined) {
      try { await transport.close(); } catch (cleanupError) { error.cleanupError = cleanupError; }
    }
    try { await rm(directory, { recursive: true, force: true }); } catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  }
}

import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { publicationFile, validatePublicationQualification } from "./publication-admission.mjs";
import { PublicationError, requirePublication } from "./publication-plan.mjs";
import { sha256 } from "./release-record-data.mjs";

/** Omitted/empty protobuf JSON defaults only; retain every other field and input. */
function withoutEmptySigstoreDefaults(bundle) {
  const comparable = structuredClone(bundle);
  const signatures = comparable?.dsseEnvelope?.signatures;
  if (Array.isArray(signatures)) {
    for (const signature of signatures) if (signature?.keyid === "") delete signature.keyid;
  }
  const timestamps = comparable?.verificationMaterial?.timestampVerificationData;
  if (Array.isArray(timestamps?.rfc3161Timestamps) && timestamps.rfc3161Timestamps.length === 0) {
    delete timestamps.rfc3161Timestamps;
  }
  return comparable;
}

/** Public, credential-free registry observations; no 404-to-absence inference. */
export function publicationRegistry({ registry = "https://registry.npmjs.org/", fetcher = fetch,
  timeoutMs = 30000, maxBytes = 4 * 1024 * 1024, clock = Date.now,
  pause = (milliseconds, signal) => delay(milliseconds, undefined, { signal }) } = {}) {
  const base = new URL(registry);
  requirePublication(base.href === "https://registry.npmjs.org/"
    || (base.protocol === "http:" && base.hostname === "127.0.0.1" && base.pathname === "/"), "PUBLICATION_REGISTRY_ORIGIN");
  const observations = [];
  async function json(url, signal) {
    const target = new URL(url, base);
    requirePublication(target.origin === base.origin && !target.username && !target.password && !target.hash,
      "PUBLICATION_REGISTRY_ENDPOINT");
    const observation = { at: new Date(clock()).toISOString(), urlSha256: sha256(Buffer.from(target.href)),
      status: null, sha256: null, receivedBytes: 0 };
    observations.push(observation);
    const response = await fetcher(target, { method: "GET", headers: { Accept: "application/json" },
      redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    observation.status = response.status;
    if (![200, 404].includes(response.status)) await response.body?.cancel();
    requirePublication([200, 404].includes(response.status), "PUBLICATION_REGISTRY_RESPONSE");
    const chunks = []; let count = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          count += next.value.length;
          observation.receivedBytes = count;
          requirePublication(count <= maxBytes, "PUBLICATION_REGISTRY_RESPONSE_LIMIT"); chunks.push(next.value);
        }
      } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
    }
    const raw = Buffer.concat(chunks);
    observation.sha256 = sha256(raw);
    return { status: response.status, value: response.status === 404 ? null : JSON.parse(raw) };
  }
  async function inspect(plan, mode, signal) {
    const result = await json(encodeURIComponent(plan.candidate.name).replace(/^%40/, "@"), signal);
    requirePublication(result.status === 200, "PUBLICATION_REGISTRY_VISIBILITY_UNKNOWN");
    const pack = result.value;
    requirePublication(pack.name === plan.candidate.name && pack.versions !== null && typeof pack.versions === "object"
      && !Array.isArray(pack.versions), "PUBLICATION_REGISTRY_METADATA");
    const version = pack.versions[plan.candidate.version];
    const channel = pack["dist-tags"]?.[plan.npm.channel] ?? null;
    const used = version !== undefined || Object.hasOwn(pack.time ?? {}, plan.candidate.version)
      || pack.time?.unpublished?.versions?.includes(plan.candidate.version) === true;
    if (mode === "before") {
      requirePublication(plan.npm.before.package === "existing" && plan.npm.before.version === "absent"
        && !used && channel === plan.npm.before.channel, "PUBLICATION_REGISTRY_CONFLICT");
    } else {
      const exactVersion = version?.name === plan.candidate.name && version.version === plan.candidate.version
        && version.private !== true
        && version.dist?.integrity === `sha512-${Buffer.from(plan.candidate.archiveSha512, "hex").toString("base64")}`;
      const withdrawn = pack.time?.unpublished?.versions?.includes(plan.candidate.version) === true;
      const priorChannel = typeof plan.npm.before.channel === "string" && channel === plan.npm.before.channel;
      const pending = !withdrawn && priorChannel && (exactVersion || (!used && version === undefined));
      const ready = !withdrawn && exactVersion && channel === plan.candidate.version;
      Object.assign(observations.at(-1), { phase: "after", selectedVersionPresent: version !== undefined,
        exactVersion, selectedVersionUsed: used, withdrawn,
        channel: channel === plan.candidate.version ? "selected" : priorChannel ? "previous" : "other",
        state: ready ? "ready" : pending ? "pending" : "conflict" });
      requirePublication(ready || pending, "PUBLICATION_REGISTRY_CONFLICT");
      requirePublication(ready, "PUBLICATION_REGISTRY_PENDING");
    }
    return { version, channel };
  }
  /** Ordinary OIDC intent needs a visible existing namespace and an unused version. */
  async function startingState(name, version, channel) {
    const result = await json(encodeURIComponent(name).replace(/^%40/, "@"));
    const pack = result.value;
    requirePublication(result.status === 200 && pack?.name === name && pack.versions !== null
      && typeof pack.versions === "object" && !Array.isArray(pack.versions), "PUBLICATION_REGISTRY_VISIBILITY_UNKNOWN");
    requirePublication(!Object.hasOwn(pack.versions, version) && !Object.hasOwn(pack.time ?? {}, version)
      && pack.time?.unpublished?.versions?.includes(version) !== true, "PUBLICATION_REGISTRY_CONFLICT");
    return { package: "existing", version: "absent", channel: pack["dist-tags"]?.[channel] ?? null };
  }

  /** Only after a known successful call; never retries a write or a contradiction. */
  async function waitForPublished(plan, deadline, { signal } = {}) {
    const remaining = deadline - clock();
    requirePublication(Number.isFinite(deadline) && remaining > 0 && remaining <= 600000
      && deadline <= Date.parse(plan.window.deadline), "PUBLICATION_REGISTRY_WAIT_INVALID");
    // Fixed attempt and wall-clock bounds survive a clock rollback or a faulty pause.
    const attempts = Math.ceil(remaining / 15000) + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal?.throwIfAborted();
      if (clock() >= deadline) break;
      try {
        const result = await inspect(plan, "after", signal);
        signal?.throwIfAborted();
        requirePublication(clock() < deadline, "PUBLICATION_REGISTRY_NOT_READY");
        return result;
      } catch (error) {
        if (error.code !== "PUBLICATION_REGISTRY_PENDING") throw error;
      }
      signal?.throwIfAborted();
      if (clock() >= deadline) break;
      await pause(Math.min(15000, deadline - clock()), signal);
    }
    throw new PublicationError("PUBLICATION_REGISTRY_NOT_READY");
  }
  async function associateOriginalProof(plan, proofPath) {
    const { version } = await inspect(plan, "after");
    const locator = version.dist?.attestations?.url;
    requirePublication(typeof locator === "string", "PUBLICATION_REGISTRY_PROVENANCE_MISSING");
    const result = await json(locator);
    const proofBytes = await publicationFile(proofPath, 16 * 1024 * 1024);
    const original = JSON.parse(proofBytes);
    requirePublication(sha256(proofBytes) === plan.producer.archiveProofSha256
      && result.status === 200 && Array.isArray(result.value.attestations), "PUBLICATION_REGISTRY_PROVENANCE_MISMATCH");
    // Avoid a whole-schema round trip: protobuf codecs discard unknown fields.
    const comparableOriginal = withoutEmptySigstoreDefaults(original);
    requirePublication(result.value.attestations.filter(value => value.predicateType === "https://slsa.dev/provenance/v1"
      && isDeepStrictEqual(withoutEmptySigstoreDefaults(value.bundle), comparableOriginal)).length === 1,
    "PUBLICATION_REGISTRY_PROVENANCE_MISMATCH");
    return { status: "passed", originalProofSha256: plan.producer.archiveProofSha256,
      associatedEnvelopeSha256: observations.at(-1).sha256 };
  }
  return { inspect, startingState, waitForPublished, associateOriginalProof, observations };
}

/** Admit same-artifact consumer reports received from the separate read-only role. */
export function admitPublishedConsumers({ plan, candidate, reports, association }) {
  validatePublicationQualification(reports, candidate, plan, "registry-version");
  requirePublication(association?.status === "passed" && association.originalProofSha256 === plan.producer.archiveProofSha256,
    "PUBLICATION_REGISTRY_PROVENANCE_MISMATCH");
  return { schemaVersion: 1, status: "passed", candidate: plan.candidate,
    reports, association };
}

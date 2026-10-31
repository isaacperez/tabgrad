import { isDeepStrictEqual } from "node:util";
import { publicationFile, validatePublicationQualification } from "./publication-admission.mjs";
import { requirePublication } from "./publication-plan.mjs";
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
  timeoutMs = 30000, maxBytes = 4 * 1024 * 1024 } = {}) {
  const base = new URL(registry);
  requirePublication(base.href === "https://registry.npmjs.org/"
    || (base.protocol === "http:" && base.hostname === "127.0.0.1" && base.pathname === "/"), "PUBLICATION_REGISTRY_ORIGIN");
  const observations = [];
  async function json(url) {
    const target = new URL(url, base);
    requirePublication(target.origin === base.origin && !target.username && !target.password && !target.hash,
      "PUBLICATION_REGISTRY_ENDPOINT");
    const response = await fetcher(target, { method: "GET", headers: { Accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    requirePublication([200, 404].includes(response.status), "PUBLICATION_REGISTRY_RESPONSE");
    const chunks = []; let count = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          count += next.value.length;
          requirePublication(count <= maxBytes, "PUBLICATION_REGISTRY_RESPONSE_LIMIT"); chunks.push(next.value);
        }
      } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
    }
    const raw = Buffer.concat(chunks);
    observations.push({ urlSha256: sha256(Buffer.from(target.href)), status: response.status, sha256: sha256(raw) });
    return { status: response.status, value: response.status === 404 ? null : JSON.parse(raw) };
  }
  async function inspect(plan, mode) {
    const result = await json(encodeURIComponent(plan.candidate.name).replace(/^%40/, "@"));
    requirePublication(result.status === 200, "PUBLICATION_REGISTRY_VISIBILITY_UNKNOWN");
    const pack = result.value;
    requirePublication(pack.name === plan.candidate.name && pack.versions !== null && typeof pack.versions === "object"
      && !Array.isArray(pack.versions), "PUBLICATION_REGISTRY_METADATA");
    const version = pack.versions[plan.candidate.version];
    const channel = pack["dist-tags"]?.[plan.npm.channel] ?? null;
    const used = version !== undefined || Object.hasOwn(pack.time ?? {}, plan.candidate.version)
      || pack.time?.unpublished?.versions?.includes(plan.candidate.version);
    if (mode === "before") {
      requirePublication(plan.npm.before.package === "existing" && plan.npm.before.version === "absent"
        && !used && channel === plan.npm.before.channel, "PUBLICATION_REGISTRY_CONFLICT");
    } else {
      requirePublication(version?.name === plan.candidate.name && version.version === plan.candidate.version
        && version.private !== true && channel === plan.candidate.version
        && version.dist?.integrity === `sha512-${Buffer.from(plan.candidate.archiveSha512, "hex").toString("base64")}`,
      "PUBLICATION_REGISTRY_CONFLICT");
    }
    return { version, channel };
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
  return { inspect, associateOriginalProof, observations };
}

/** Admit same-artifact consumer reports received from the separate read-only role. */
export function admitPublishedConsumers({ plan, candidate, reports, association }) {
  validatePublicationQualification(reports, candidate, plan, "registry-version");
  requirePublication(association?.status === "passed" && association.originalProofSha256 === plan.producer.archiveProofSha256,
    "PUBLICATION_REGISTRY_PROVENANCE_MISMATCH");
  return { schemaVersion: 1, status: "passed", candidate: plan.candidate,
    reports, association };
}

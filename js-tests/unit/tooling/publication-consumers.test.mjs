import assert from "node:assert/strict";
import { mkdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { publicationServiceFixture } from "../../fixtures/publication-service.mjs";
import { controlledConsumerReport } from "../../fixtures/package-provenance.mjs";
import { canonicalBytes } from "../../../scripts/release-record-data.mjs";
import { verifyPublishedConsumerResult } from "../../../scripts/release-publication.mjs";
import { publicationRegistry } from "../../../scripts/publication-registry.mjs";

function report(f) {
  const value = controlledConsumerReport(f.candidate, canonicalBytes(f.candidate), { input: "registry-version" });
  value.registry = { status: "passed", npm: "11.1.0", channel: f.plan.npm.channel, transport: { rejected: 0 },
    consumedArchive: f.candidate.tarball,
    checks: ["exact-registry-metadata", "channel", "dependency-boundary", "downloaded-archive-identity",
      "approved-cache-population", "named-registry-installation", "consumed-archive-integrity", "installed-inventory"] };
  return value;
}

for (const phase of ["success", "registry", "provenance", "consumers", "child-report", "admission"]) {
  test(`actual consumer orchestration conserves safe ${phase} evidence without publishing`, async t => {
    const f = await publicationServiceFixture(t); f.applyPublishedState();
    await mkdir(join(f.root, "public-output"), { recursive: true });
    const options = { plan: f.plan, candidate: f.candidate, proof: f.material.proof, registry: f.registry,
      report: async () => [report(f)] };
    if (phase === "registry") {
      options.registry = publicationRegistry({ fetcher: async () => new Response(JSON.stringify({
        name: f.plan.candidate.name, versions: { [f.plan.candidate.version]: { name: "contrary" } },
        "dist-tags": { latest: f.plan.candidate.version },
      })) });
    }
    if (phase === "provenance") options.proof = join(f.root, "absent-proof.json");
    if (phase === "consumers") options.report = async () => { throw new Error("PRIVATE DETAILS"); };
    if (phase === "child-report") options.report = async () => {
      throw Object.assign(new Error("PRIVATE DETAILS"), { code: "PUBLICATION_CLIENT_REJECTED", privateClientEvidence: {
        stdout: JSON.stringify({ schemaVersion: 1, input: "registry-version", status: "failed",
          failure: { phase: "Chrome-direct", code: "BROWSER_FAILED", message: "PRIVATE DETAILS" }, privateField: f.root }),
        stderr: "PRIVATE DETAILS",
      } });
    };
    if (phase === "admission") options.report = async () => { const r = report(f); r.profiles[0].status = "failed"; return [r]; };
    if (phase === "success") {
      assert.equal((await verifyPublishedConsumerResult(f.root, options)).status, "published-consumers-verified");
      assert.equal(JSON.parse(await readFile(join(f.root, "public-output/consumers.json"))).status, "passed");
    } else {
      await assert.rejects(verifyPublishedConsumerResult(f.root, options));
      await assert.rejects(access(join(f.root, "public-output/consumers.json")));
    }
    const raw = await readFile(join(f.root, "public-output/consumer-diagnostics.json"), "utf8"), evidence = JSON.parse(raw);
    assert.equal(evidence.status, phase === "success" ? "passed" : "failed");
    assert.ok(evidence.observations.length > 0); assert.equal(evidence.omittedObservations, 0);
    assert.equal(raw.includes("PRIVATE DETAILS"), false); assert.equal(raw.includes(f.root), false);
    assert.equal(raw.includes("fixture-not-a-credential"), false);
    assert.deepEqual(evidence.consumerFailure, phase === "child-report" ? { phase: "Chrome-direct", code: "BROWSER_FAILED" } : null);
    assert.equal(f.calls, 0); // This route never invokes the fixture's publishing client.
  });
}

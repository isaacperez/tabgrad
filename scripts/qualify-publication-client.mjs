import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { identifyPublicationClient, publicationEnvironment, runPublicationProcess } from "./publication-client.mjs";
import { inspectBootstrapNamespace, prepareNpmRole, publishNpmArchive } from "./publication-npm.mjs";
import { canonicalBytes, sha256 } from "./release-record-data.mjs";
import { requirePublication } from "./publication-plan.mjs";

/** Actual selected npm, original public signature, local registry and fake auth. */
export async function qualifyPublicationClient({ clientDirectory, clientSha256, fixturesDirectory }) {
  const manifest = JSON.parse(await readFile(new URL("../js-tests/fixtures/publication-client.json", import.meta.url)));
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-publication-client-"));
  const report = { schemaVersion: 1, status: "failed", input: "original-upstream-proof-local-registry",
    checks: [], realNpmProvider: "unqualified", tabgradSignedPair: "unqualified", realOidcBinding: "unqualified" };
  const privateEvidence = [];
  let failure;
  try {
    const client = await identifyPublicationClient(clientDirectory, clientSha256,
      { timeoutMs: 15000, maxOutputBytes: 1024 * 1024 });
    report.client = { node: client.node.version, npm: client.npm.version, manifestSha256: clientSha256 };
    const originals = new Map();
    for (const file of manifest.files) {
      const raw = await readFile(join(fixturesDirectory, file.name));
      requirePublication(raw.length === file.byteLength && sha256(raw) === file.sha256, "PUBLICATION_FIXTURE_CHANGED");
      originals.set(file.name, raw);
    }
    const envelope = JSON.parse(originals.get("attestations-original.json"));
    const matches = envelope.attestations.filter(a => a.predicateType === "https://slsa.dev/provenance/v1");
    requirePublication(matches.length === 1, "PUBLICATION_FIXTURE_CHANGED");
    const proof = Buffer.from(`${JSON.stringify(matches[0].bundle)}\n`);
    requirePublication(sha256(proof) === manifest.derivedProofSha256, "PUBLICATION_FIXTURE_CHANGED");
    report.checks.push({ name: "independently-identified-original-inputs", status: "passed" });
    const originalArchive = originals.get("core-3.0.1.tgz");
    for (const name of ["original", "bootstrap-non-owner", "oidc-exchange", "oidc-rejects", "changed-signature", "changed-payload", "changed-archive", "registry-rejects", "registry-disconnects"]) {
      const state = join(directory, name);
      await mkdir(state, { mode: 0o700 });
      let archive = originalArchive;
      const bundle = JSON.parse(proof);
      if (name === "changed-signature") {
        const sig = Buffer.from(bundle.dsseEnvelope.signatures[0].sig, "base64"); sig[0] ^= 1;
        bundle.dsseEnvelope.signatures[0].sig = sig.toString("base64");
      }
      if (name === "changed-payload") {
        const payload = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64"));
        payload.subject[0].name += "-changed";
        bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(payload)).toString("base64");
      }
      if (name === "changed-archive") archive = Buffer.concat([originalArchive, Buffer.from("changed")]);
      const archivePath = join(state, "candidate.tgz"), proofPath = join(state, "original-proof.json");
      await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
      await writeFile(proofPath, `${JSON.stringify(bundle)}\n`, { flag: "wx", mode: 0o600 });
      const calls = [], writes = [], sockets = new Set();
      const server = createServer(async (req, res) => {
        try {
          let size = 0; const chunks = [];
          for await (const chunk of req) {
            size += chunk.length;
            requirePublication(size <= 1024 * 1024, "PUBLICATION_FIXTURE_LIMIT"); chunks.push(chunk);
          }
          calls.push({ method: req.method, path: req.url, bytes: size });
          if (req.url === "/-/whoami") return jsonReply(res, 200, { username: "fixture-owner" });
          if (req.url === "/-/org/actions/user") return jsonReply(res, 200,
            { "fixture-owner": name === "bootstrap-non-owner" ? "developer" : "owner" });
          if (req.url === "/fixture-id-token?audience=npm%3A127.0.0.1") {
            assert.equal(req.headers.authorization, "Bearer fixture-request-not-a-credential");
            res.writeHead(200, { "content-type": "application/json" }).end('{"value":"fixture-id-not-a-credential"}');
          } else if (req.url === "/-/npm/v1/oidc/token/exchange/package/@actions%2fcore") {
            assert.equal(req.headers.authorization, "Bearer fixture-id-not-a-credential");
            res.writeHead(name === "oidc-rejects" ? 403 : 201, { "content-type": "application/json" })
              .end(JSON.stringify(name === "oidc-rejects" ? { error: "fixture rejection" }
                : { token: "fixture-exchanged-not-a-credential" }));
          } else if (req.method === "PUT") {
            assert.equal(req.headers.authorization, name === "oidc-exchange"
              ? "Bearer fixture-exchanged-not-a-credential" : "Bearer fixture-only-not-a-credential");
            writes.push(Buffer.concat(chunks));
            if (name === "registry-disconnects") { req.socket.destroy(); return; }
            res.writeHead(name === "registry-rejects" ? 403 : 201, { "content-type": "application/json" })
              .end(JSON.stringify(name === "registry-rejects" ? { error: "fixture rejection" } : { ok: true }));
          } else res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}');
        } catch { req.socket.destroy(); }
      });
      server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
      await new Promise((resolve_, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve_); });
      let result, error;
      try {
        const registry = `http://127.0.0.1:${server.address().port}/`;
        const role = await prepareNpmRole({ directory: state, registry,
          authentication: { kind: name.startsWith("oidc-") ? "fixture-oidc" : "fixture" } });
        if (["original", "bootstrap-non-owner"].includes(name)) {
          const reader = { schemaVersion: 1, username: "fixture-owner", scope: "actions",
            namespaceVisibility: "qualified-owner", evidenceSha256: "f".repeat(64),
            expiresAt: new Date(Date.now() + 60000).toISOString() };
          await inspectBootstrapNamespace({ client, role, plan: { candidate: { name: manifest.package } },
            reader, expectedReaderSha256: sha256(canonicalBytes(reader)) });
          report.checks.push({ name: "actual-cli-bootstrap-reader-isolated-fixture", status: "passed" });
        }
        result = await publishNpmArchive({ client, role, archive: archivePath, proof: proofPath, channel: "latest", timeoutMs: 45000 });
      } catch (caught) { error = caught; }
      finally {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve_ => server.close(resolve_));
      }
      privateEvidence.push({ name, calls, result, failure: error?.privateClientEvidence });
      if (["original", "oidc-exchange"].includes(name)) {
        requirePublication(!error && writes.length === 1, "PUBLICATION_CONTROL_FAILED");
        const body = JSON.parse(writes[0]);
        const attachment = body._attachments["@actions/core-3.0.1.tgz"];
        assert.deepEqual(Buffer.from(attachment.data, "base64"), originalArchive);
        const delivered = JSON.parse(body._attachments["@actions/core-3.0.1.sigstore"].data);
        assert.deepEqual(delivered, bundle);
        assert.equal(delivered.dsseEnvelope.payload, bundle.dsseEnvelope.payload);
        assert.deepEqual(delivered.dsseEnvelope.signatures, bundle.dsseEnvelope.signatures);
        if (name === "oidc-exchange") {
          assert.equal(calls.filter(call => call.path.startsWith("/fixture-id-token?")).length, 1);
          assert.equal(calls.filter(call => call.path.startsWith("/-/npm/v1/oidc/token/exchange/")).length, 1);
        }
        report.checks.push({ name: `${name}-actual-crypto-exact-archive-original-signed-payload-and-signatures`, status: "passed" });
      } else {
        const expectedWrites = name.startsWith("registry-") ? 1 : 0;
        requirePublication((name === "bootstrap-non-owner" ? error?.code === "PUBLICATION_BOOTSTRAP_OWNER_CHANGED"
          : error?.code === "PUBLICATION_CLIENT_REJECTED" && error.dispatched === true)
          && writes.length === expectedWrites, "PUBLICATION_CONTROL_FAILED");
        report.checks.push({ name, status: "rejected-as-required", writes: writes.length,
          outcome: expectedWrites === 1 ? "unknown-without-reconciliation" : "fixture-observed-no-registry-write" });
      }
    }
    // Exercise the maintained HTTP adapter on the identified publishing Node,
    // rather than quietly qualifying only the repository's build Node runtime.
    const runtimes = new Map([[process.execPath, "controller-node-github-http-controls"],
      [client.executable, "npm-node-github-http-controls"]]);
    for (const [runtime, name] of runtimes) {
      const httpControls = await runPublicationProcess(runtime, ["--test",
        fileURLToPath(new URL("../js-tests/unit/distribution/publication-github.test.mjs", import.meta.url))],
      { directory, environment: publicationEnvironment(directory), timeoutMs: 30000, maxOutputBytes: 1024 * 1024 });
      privateEvidence.push({ name, result: httpControls });
      report.checks.push({ name, status: "passed", nodeSha256: sha256(await readFile(runtime)),
        outputSha256: sha256(Buffer.from(httpControls.stdout)) });
    }
    report.status = "passed";
  } catch (error) { failure = error; }
  try { await rm(directory, { recursive: true, force: true }); report.cleanup = "completed"; }
  catch (error) { failure ??= error; report.cleanup = "failed"; }
  if (failure) { failure.report = report; failure.privateQualificationEvidence = privateEvidence; throw failure; }
  return { report, privateEvidence };
}

function jsonReply(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let report;
  try {
    requirePublication(process.argv.length === 5, "PUBLICATION_USAGE");
    ({ report } = await qualifyPublicationClient({ clientDirectory: process.argv[2], clientSha256: process.argv[3],
      fixturesDirectory: process.argv[4] }));
  } catch (error) {
    report = { ...error.report, status: "failed", failure: { code: error.code ?? "PUBLICATION_QUALIFICATION_FAILED" } };
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

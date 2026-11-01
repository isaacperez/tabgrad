import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { releasePreparationFixture } from "../../fixtures/release-preparation.mjs";
import { collectReleaseQualification, collectRegistryQualification, publishReleaseQualification } from "../../../scripts/release-qualification.mjs";
import { selectReleaseInputs, composeReleaseInputs } from "../../../scripts/prepare-release.mjs";
import { canonicalBytes, sha256 } from "../../../scripts/release-record-data.mjs";

const options = f => ({ repository: "example/project", clock: f.clock });

test("collects the actual exact-archive physical report, isolated from publication credentials, without posting", async t => {
  const f = await releasePreparationFixture(t), output = join(f.directory, "physical"); let calls = 0;
  const result = await collectReleaseQualification(f.data, output,
    { PATH: process.env.PATH, GH_TOKEN: "private-reader", NPM_TOKEN: "private-writer", NODE_OPTIONS: "--bad", HOME: "/private/home" },
    { ...options(f), run: async (file, args, config) => {
      calls++; assert.equal(file, process.execPath); assert.ok(args.includes("--tarball")); assert.ok(args.includes("--gpu"));
      assert.equal(args.at(-1), "Chrome"); assert.equal(config.environment.GH_TOKEN, undefined);
      assert.equal(config.environment.NPM_TOKEN, undefined); assert.equal(config.environment.NODE_OPTIONS, undefined);
      assert.equal(config.environment.HOME, join(output, "home")); assert.ok(config.timeoutMs <= 600000);
      return { stdout: JSON.stringify(f.gpu) };
    } });
  assert.equal(calls, 1); assert.equal(result.status, "collected-for-inspection");
  const message = await readFile(join(output, "message.txt")); assert.equal(result.messageSha256, sha256(message));
  assert.ok(message.toString().startsWith(`tabgrad-release-qualification 131/1 ${sha256(f.bytes)}\n`));
  assert.deepEqual(JSON.parse(await readFile(join(output, "report.json"))), f.gpu);
  assert.equal((await readdir(output)).includes("publication-claimed.json"), false);
});

for (const name of ["fallback", "registry", "candidate", "cleanup"]) test(`pre-publication collection refuses ${name} evidence`, async t => {
  const f = await releasePreparationFixture(t), report = structuredClone(f.gpu);
  if (name === "fallback") report.profiles[0].gpu.adapter.isFallbackAdapter = true;
  if (name === "registry") report.input = "registry-version";
  if (name === "candidate") report.expectedEvidenceSha256 = "0".repeat(64);
  if (name === "cleanup") report.cleanupFailure = { code: "failed" };
  await assert.rejects(collectReleaseQualification(f.data, join(f.directory, "physical"), {}, {
    ...options(f), run: async () => ({ stdout: JSON.stringify(report) }) }));
});

test("collection rejects overlapping output or foreign repository before any consumer execution", async t => {
  const f = await releasePreparationFixture(t); let calls = 0;
  const ports = { ...options(f), run: async () => { calls++; } };
  await assert.rejects(collectReleaseQualification(f.data, join(f.data, "output"), {}, ports), { code: "PUBLICATION_PHYSICAL_OUTPUT_OVERLAP" });
  await assert.rejects(collectReleaseQualification(f.data, join(f.directory, "physical"), {}, { ...ports, repository: "other/repository" }),
    { code: "PUBLICATION_PHYSICAL_REPOSITORY" }); assert.equal(calls, 0);
});

test("posting is one explicit attributed write; unknown response is conserved and cannot be blindly retried", async t => {
  const f = await releasePreparationFixture(t), directory = join(f.directory, "physical");
  await collectReleaseQualification(f.data, directory, {}, { ...options(f), run: async () => ({ stdout: JSON.stringify(f.gpu) }) });
  let calls = 0; const api = { request: async (route, config) => { calls++; assert.equal(route, "/issues/55/comments");
    assert.equal(config.method, "POST"); throw Object.assign(new Error("private diagnostic"), { code: "PUBLICATION_HTTP_UNAVAILABLE" }); } };
  await assert.rejects(publishReleaseQualification(directory, "55", {}, { repository: "example/project", api }), { code: "PUBLICATION_PHYSICAL_RESPONSE_UNKNOWN" });
  await assert.rejects(publishReleaseQualification(directory, "55", {}, { repository: "example/project", api })); assert.equal(calls, 1);
  const raw = await readFile(join(directory, "publication-result.json"), "utf8");
  assert.equal(JSON.parse(raw).status, "unknown"); assert.equal(raw.includes("private diagnostic"), false);
});

test("posting verifies the inspected bytes and independently selected repository", async t => {
  const f = await releasePreparationFixture(t), directory = join(f.directory, "physical");
  await collectReleaseQualification(f.data, directory, {}, { ...options(f), run: async () => ({ stdout: JSON.stringify(f.gpu) }) });
  let calls = 0; const api = { request: async (_route, { body }) => { calls++; return { body: body.body, id: 901 }; } };
  await assert.rejects(publishReleaseQualification(directory, "55", {}, { repository: "other/project", api }), { code: "PUBLICATION_PHYSICAL_REPOSITORY" });
  const receipt = await publishReleaseQualification(directory, "55", {}, { repository: "example/project", api });
  assert.equal(receipt.commentId, "901"); assert.equal(calls, 1);
});

test("post-npm collection performs a separate registry installation and constructs the exact existing observation header", async t => {
  const f = await releasePreparationFixture(t), ports = { ...options(f), api: f.api, replay: f.replay, registry: f.registry };
  await selectReleaseInputs(f.root, f.environment, ports); await f.receive();
  const result = await composeReleaseInputs(f.root, f.environment, ports);
  await mkdir(join(f.root, "admission/input"), { recursive: true });
  const raw = await readFile(join(f.root, "input/plan.json")), plan = JSON.parse(raw);
  await writeFile(join(f.root, "admission/input/plan.json"), raw);
  await writeFile(join(f.root, "admission/admission.json"), canonicalBytes({ status: "passed", planSha256: result.plan_sha256,
    context: { revision: f.environment.GITHUB_SHA, attempt: "1", runId: "301" } }));
  const report = structuredClone(f.gpu); report.input = "registry-version"; report.checks.push("supplied-archive-installation");
  report.registry = { status: "passed", npm: "11.1.0", channel: "latest", transport: { rejected: 0 }, consumedArchive: { ...f.candidate.tarball },
    checks: ["exact-registry-metadata", "channel", "dependency-boundary", "downloaded-archive-identity", "approved-cache-population",
      "named-registry-installation", "consumed-archive-integrity", "installed-inventory"] };
  const output = join(f.directory, "registry-physical");
  await collectRegistryQualification(f.root, output, {}, { ...options(f), run: async (_file, args) => {
    assert.ok(args.includes("--registry-plan")); assert.equal(args.includes("--tarball"), false);
    const registryPlan = JSON.parse(await readFile(args[args.indexOf("--registry-plan") + 1]));
    assert.equal(registryPlan.channel, "latest"); return { stdout: JSON.stringify(report) };
  } });
  const message = await readFile(join(output, "message.txt"), "utf8");
  assert.ok(message.startsWith(`tabgrad-release-gpu-consumers ${result.plan_sha256} ${plan.operation} 301/1\n`));
});

test("real collector CLI parses its maintained command before touching any device, and default preparation remains inert", async t => {
  const f = await releasePreparationFixture(t);
  for (const command of ["collect", "collect-registry"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../../scripts/release-qualification.mjs", import.meta.url)),
      command, join(f.directory, "missing"), join(f.directory, "output")], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).code, "ENOENT"); assert.equal(result.stderr, "");
  }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../../scripts/prepare-release.mjs", import.meta.url)), "select", f.root],
    { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).code, "PUBLICATION_DISABLED"); assert.equal(result.stderr, "");
});

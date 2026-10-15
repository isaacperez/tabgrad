import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { packageFixture } from "../../fixtures/package-candidate.mjs";
import { packageRegistry } from "../../fixtures/package-registry.mjs";
import { createRegistryPackageApplication, registryEnvironment, validateRegistryPlan } from "../../../scripts/package-registry.mjs";
import { qualifyPackage, parsePackageArguments } from "../../../scripts/run-package-browser-tests.mjs";

test("real npm resolves, downloads and installs the exact named registry version with admitted bytes", async context => {
  const input = await packageFixture(context);
  const registry = await packageRegistry(context, input);
  let application;
  try {
    application = await createRegistryPackageApplication({ registryPlan: registry.plan, expected: input.expected });
    assert.equal(application.registry.status, "passed");
    assert.equal(application.registry.npm, "11.1.0");
    assert.equal(application.registry.producerAuthentication, "unqualified");
    assert.equal(application.registry.releaseAdmission, "unqualified");
    assert.deepEqual(await readFile(application.tarball), input.bytes);
    assert.ok(application.registry.transport.requests > 0, "npm bypassed the origin guard");
    assert.equal(application.registry.transport.rejected, 0);
    assert.ok(registry.requests.some(request => request.url.includes(".tgz")));
    assert.ok(registry.requests.every(request => request.authorization === undefined && request.method === "GET"));
    const lock = JSON.parse(await readFile(`${application.application}/package-lock.json`, "utf8"));
    assert.equal(lock.packages[`node_modules/${input.expected.name}`].resolved, `${registry.origin}/package.tgz`);
    await assert.rejects(access(input.lifecycleMarker));
  } finally { await application?.close(); }
});

test("registry npm environment excludes inherited identity, configuration and injection", () => {
  const result = registryEnvironment("/owned", { PATH: "/prepared", NPM_TOKEN: "sentinel", NODE_AUTH_TOKEN: "sentinel",
    GITHUB_TOKEN: "sentinel", NODE_OPTIONS: "sentinel", NPM_CONFIG_REGISTRY: "sentinel", HTTPS_PROXY: "sentinel", SSH_AUTH_SOCK: "sentinel" });
  assert.equal(result.PATH, "/prepared");
  assert.ok(!JSON.stringify(result).includes("sentinel"));
});

test("registry plans require explicit admitted origins and finite client bounds", () => {
  const plan = { schemaVersion: 1, registry: "https://registry.example.invalid/", allowedOrigins: ["https://registry.example.invalid"],
    channel: "latest", clientTimeoutMs: 1000, maxClientOutputBytes: 4096 };
  assert.equal(validateRegistryPlan(plan).registry, plan.registry);
  for (const update of [{ registry: "https://user:secret@registry.example.invalid/" }, { allowedOrigins: [] }, { clientTimeoutMs: 0 },
    { registry: "http://registry.example.invalid/" }, { channel: "1.2.3" }, { extra: true }]) {
    assert.throws(() => validateRegistryPlan({ ...plan, ...update }), { code: "REGISTRY_PLAN_INVALID" });
  }
});

for (const [name, options, code] of [
  ["name", { metadata: { name: "@other/package" } }, "REGISTRY_METADATA_MISMATCH"],
  ["version", { metadata: { version: "0.9.8" } }, "REGISTRY_METADATA_MISMATCH"],
  ["integrity", { metadata: { dist: { integrity: "sha512-wrong", tarball: "http://127.0.0.1:1/p.tgz" } } }, "REGISTRY_METADATA_MISMATCH"],
  ["channel", { tags: { latest: "0.9.8" } }, "REGISTRY_CHANNEL_MISMATCH"],
  ["missing channel", { packument: { "dist-tags": {} } }, "REGISTRY_CHANNEL_MISMATCH"],
  ["dependencies", { metadata: { dependencies: { unexpected: "1.0.0" } } }, "REGISTRY_DEPENDENCIES_REJECTED"],
  ["peer dependencies", { metadata: { peerDependencies: { unexpected: "1.0.0" } } }, "REGISTRY_DEPENDENCIES_REJECTED"],
  ["optional dependencies", { metadata: { optionalDependencies: { unexpected: "1.0.0" } } }, "REGISTRY_DEPENDENCIES_REJECTED"],
  ["missing response", { status: 404, text: '{"error":"not found"}' }, "REGISTRY_CLIENT_FAILED"],
  ["malformed response", { text: "{" }, "REGISTRY_CLIENT_FAILED"],
  ["archive origin", { metadata: ({ input }) => ({ dist: { integrity: input.expected.tarball.integrity,
    tarball: "https://unadmitted.example.invalid/p.tgz" } }) }, "REGISTRY_ENDPOINT_REJECTED"],
]) {
  test(`registry rejects ${name} before any archive consumer`, async context => {
    const input = await packageFixture(context);
    const registry = await packageRegistry(context, input, options);
    await assert.rejects(createRegistryPackageApplication({ registryPlan: registry.plan, expected: input.expected }), error => {
      assert.equal(error.code, code);
      assert.equal(error.registry.status, "failed");
      assert.equal(error.registry.phase, "registry-metadata");
      assert.deepEqual(error.registry.checks, []);
      return true;
    });
    assert.ok(!registry.requests.some(request => request.url.includes(".tgz")));
    await assert.rejects(access(input.lifecycleMarker));
  });
}

test("registry downloaded bytes cannot substitute an equivalent-looking archive", async context => {
  const input = await packageFixture(context);
  const registry = await packageRegistry(context, input, { bytes: Buffer.alloc(input.bytes.length, 120) });
  await assert.rejects(createRegistryPackageApplication({ registryPlan: registry.plan, expected: input.expected }), error => {
    assert.equal(error.registry.phase, "registry-archive");
    assert.ok(error.registry.checks.includes("channel"));
    assert.equal(error.registry.status, "failed");
    assert.equal(error.code, "ARCHIVE_MISMATCH");
    return true;
  });
  await assert.rejects(access(input.lifecycleMarker));
});

test("unadmitted redirect is denied by the actual npm origin guard", async context => {
  const input = await packageFixture(context);
  const escaped = await packageRegistry(context, input);
  const registry = await packageRegistry(context, input, { response(_request, response) {
    response.writeHead(302, { location: `${escaped.origin}/metadata` }); response.end();
  } });
  await assert.rejects(createRegistryPackageApplication({ registryPlan: registry.plan, expected: input.expected }), error => {
    assert.equal(error.code, "REGISTRY_ENDPOINT_REJECTED");
    assert.ok(error.registry.transport.rejected > 0);
    return true;
  });
  assert.deepEqual(escaped.requests, []);
});

test("interrupted response preserves earlier metadata checks and fails without running consumers", async context => {
  const input = await packageFixture(context);
  const registry = await packageRegistry(context, input, { response(request, response, { origin }) {
    if (request.url.endsWith(".tgz")) {
      response.writeHead(200, { "content-length": input.bytes.length });
      response.write(input.bytes.subarray(0, 10), () => response.destroy());
    }
    else response.end(JSON.stringify({ name: input.expected.name, "dist-tags": { latest: input.expected.version }, versions: {
      [input.expected.version]: { name: input.expected.name, version: input.expected.version,
        dist: { tarball: `${origin}/p.tgz`, integrity: input.expected.tarball.integrity } },
    } }));
  } });
  await assert.rejects(createRegistryPackageApplication({ registryPlan: registry.plan, expected: input.expected }), error => {
    assert.equal(error.registry.phase, "registry-archive");
    assert.equal(error.code, "REGISTRY_DOWNLOAD_FAILED");
    assert.ok(error.registry.checks.includes("exact-registry-metadata"));
    assert.ok(!error.registry.checks.includes("approved-cache-population"));
    return true;
  });
  await assert.rejects(access(input.lifecycleMarker));
});

test("metadata timeout and client-output bound are finite failures", async context => {
  const input = await packageFixture(context);
  const registry = await packageRegistry(context, input, { response(_request, _response) {} });
  await assert.rejects(createRegistryPackageApplication({ registryPlan: { ...registry.plan, clientTimeoutMs: 3000 }, expected: input.expected }),
    error => {
      assert.ok(["REGISTRY_CLIENT_TIMEOUT", "REGISTRY_CLIENT_FAILED"].includes(error.code));
      assert.equal(error.registry.phase, "registry-metadata");
      assert.ok(registry.requests.length > 0);
      return true;
    });
  const ordinary = await packageRegistry(context, input);
  await assert.rejects(createRegistryPackageApplication({ registryPlan: { ...ordinary.plan, maxClientOutputBytes: 3 }, expected: input.expected }),
    { code: "REGISTRY_CLIENT_OUTPUT_LIMIT" });
});

async function withEnvironment(values, work) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try { Object.assign(process.env, values); return await work(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

async function npmWrapper(input, source, before = "") {
  let actual;
  for (const directory of process.env.PATH.split(delimiter)) {
    const candidate = resolve(directory, "npm");
    try { await access(candidate); actual = candidate; break; } catch { /* Next prepared path. */ }
  }
  assert.ok(actual, "Prepared npm is unavailable");
  const directory = join(input.directory, "commands");
  const observations = join(input.directory, "client-observations.jsonl");
  await mkdir(directory);
  const script = `#!/usr/bin/env node
const fs = require('node:fs'); const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify({args, cwd:process.cwd(), injected:process.env.NODE_OPTIONS, token:process.env.NPM_TOKEN})+'\\n');
${before}
const result = spawnSync(${JSON.stringify(actual)}, args, {stdio:'inherit'});
${source}
process.exit(result.status ?? 1);
`;
  await writeFile(join(directory, "npm"), script);
  await chmod(join(directory, "npm"), 0o755);
  return { directory, observations };
}

test("actual registry commands ignore hostile config, caches, identities and Node injection", async context => {
  const input = await packageFixture(context);
  const registry = await packageRegistry(context, input);
  const other = await packageRegistry(context, input);
  const hostile = join(input.directory, "hostile");
  await mkdir(hostile);
  const marker = join(hostile, "injection-ran");
  await writeFile(join(hostile, "injection.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`);
  await writeFile(join(hostile, ".npmrc"), `registry=${other.origin}/\n@tabgrad:registry=${other.origin}/\n//127.0.0.1:${new URL(registry.origin).port}/:_authToken=synthetic-private-token\n`);
  const wrapper = await npmWrapper(input, "");
  await withEnvironment({ PATH: `${wrapper.directory}${delimiter}${process.env.PATH}`, HOME: hostile,
    NPM_CONFIG_USERCONFIG: join(hostile, ".npmrc"), NPM_CONFIG_REGISTRY: `${other.origin}/`, NPM_CONFIG_CACHE: hostile,
    NPM_TOKEN: "synthetic-private-token", NODE_AUTH_TOKEN: "synthetic-private-token", GITHUB_TOKEN: "synthetic-private-token",
    NODE_OPTIONS: `--require=${join(hostile, "injection.cjs")}`, HTTPS_PROXY: other.origin, NO_PROXY: "*" }, async () => {
    const application = await createRegistryPackageApplication({ registryPlan: registry.plan, expected: input.expected });
    try { assert.equal(application.registry.status, "passed"); } finally { await application.close(); }
  });
  const calls = (await readFile(wrapper.observations, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const install = calls.find(call => call.args[0] === "install");
  assert.equal(install.args[1], `${input.expected.name}@${input.expected.version}`);
  for (const flag of ["--offline", "--ignore-scripts", "--bin-links=false", "--save-exact"]) assert.ok(install.args.includes(flag));
  assert.ok(calls.every(call => call.injected === undefined && call.token === undefined));
  assert.deepEqual(other.requests, []);
  assert.ok(registry.requests.every(request => request.authorization === undefined));
  await assert.rejects(access(marker));
  assert.deepEqual((await readdir(hostile)).sort(), [".npmrc", "injection.cjs"]);
});

for (const [name, source, code] of [
  ["lock integrity", `if(args[0]==='install' && result.status===0){const p='package-lock.json';const x=JSON.parse(fs.readFileSync(p));x.packages['node_modules/@tabgrad/retained-fixture'].integrity='sha512-wrong';fs.writeFileSync(p,JSON.stringify(x));}`, "REGISTRY_INSTALL_MISMATCH"],
  ["installed bytes", `if(args[0]==='install' && result.status===0)fs.appendFileSync('node_modules/@tabgrad/retained-fixture/dist/index.js','changed');`, "CONTENT_MISMATCH"],
  ["consumed cache archive", `if(args[0]==='install' && result.status===0){const root=args[args.indexOf('--cache')+1]+'/_cacache/content-v2/sha512';for(const a of fs.readdirSync(root))for(const b of fs.readdirSync(root+'/'+a))for(const c of fs.readdirSync(root+'/'+a+'/'+b)){const p=root+'/'+a+'/'+b+'/'+c;const x=fs.readFileSync(p);if(x[0]===31&&x[1]===139)fs.appendFileSync(p,'changed');}}`, "ARCHIVE_MISMATCH"],
]) {
  test(`independent ${name} check rejects after an otherwise successful npm install`, async context => {
    const input = await packageFixture(context);
    const registry = await packageRegistry(context, input);
    const wrapper = await npmWrapper(input, source);
    await withEnvironment({ PATH: `${wrapper.directory}${delimiter}${process.env.PATH}` }, async () => {
      await assert.rejects(createRegistryPackageApplication({ registryPlan: registry.plan, expected: input.expected }), { code });
    });
    await assert.rejects(access(input.lifecycleMarker));
  });
}

test("registry success and failure remove owned applications/cache and preserve original inputs", async context => {
  const input = await packageFixture(context);
  const temporary = await mkdtemp(join(input.directory, "temporary-"));
  const good = await packageRegistry(context, input);
  const bad = await packageRegistry(context, input, { tags: { latest: "0.9.8" } });
  await withEnvironment({ TMPDIR: temporary }, async () => {
    const application = await createRegistryPackageApplication({ registryPlan: good.plan, expected: input.expected });
    await application.close();
    await assert.rejects(createRegistryPackageApplication({ registryPlan: bad.plan, expected: input.expected }));
  });
  assert.deepEqual(await readdir(temporary), []);
  assert.deepEqual(await readFile(input.tarball), input.bytes);
});

test("registry arguments are explicit and mutually exclusive with supplied archives", () => {
  assert.deepEqual(parsePackageArguments(["--registry-plan", "private.json", "--expected", "candidate.json"]),
    { gpu: false, "registry-plan": resolve("private.json"), expected: resolve("candidate.json") });
  for (const args of [["--registry-plan", "p"], ["--registry-plan", "p", "--tarball", "a", "--expected", "e"],
    ["--registry-plan", "p", "--registry-plan", "q", "--expected", "e"]]) {
    assert.throws(() => parsePackageArguments(args), { code: "ARGUMENTS_INVALID" });
  }
});

test("registry CLI failures report safe partial evidence and joined cleanup", async context => {
  const input = await packageFixture(context);
  const registry = await packageRegistry(context, input, { tags: { latest: "0.9.8" } });
  const plan = join(input.directory, "private-plan.json");
  const expected = join(input.directory, "candidate.json");
  const temporary = join(input.directory, "cli-temporary"); await mkdir(temporary);
  await writeFile(plan, JSON.stringify(registry.plan)); await writeFile(expected, JSON.stringify(input.expected));
  const child = spawn(process.execPath, [resolve("scripts/run-package-browser-tests.mjs"), "--registry-plan", plan, "--expected", expected],
    { cwd: process.cwd(), env: { ...process.env, TMPDIR: temporary }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 1);
  const report = JSON.parse(stdout);
  assert.equal(report.input, "registry-version");
  assert.equal(report.registry.phase, "registry-metadata");
  assert.equal(report.failure.code, "REGISTRY_CHANNEL_MISMATCH");
  assert.deepEqual(report.checks, []);
  assert.deepEqual(report.profiles, []);
  assert.ok(!stdout.includes(registry.origin) && !stdout.includes(input.directory));
  assert.equal(stderr, "");
  assert.deepEqual(await readdir(temporary), []);
});

test("registry installation and supplied archive share all consumers before browser selection", async context => {
  const input = await packageFixture(context, { fullRuntime: true });
  const registry = await packageRegistry(context, input);
  const plan = join(input.directory, "registry.json");
  const expected = join(input.directory, "candidate.json");
  await writeFile(plan, JSON.stringify(registry.plan)); await writeFile(expected, JSON.stringify(input.expected));
  const report = await withEnvironment({ TABGRAD_BROWSER: "Chrome", TABGRAD_CHROME: join(input.directory, "absent-browser") },
    () => qualifyPackage({ "registry-plan": plan, expected, gpu: false }));
  assert.equal(report.status, "failed");
  assert.equal(report.input, "registry-version");
  assert.equal(report.registry.status, "passed");
  assert.equal(report.failure.phase, "Chrome-availability");
  for (const check of ["supplied-archive-installation", "public-entries", "public-types", "cpu-assets", "static-inventory"]) assert.ok(report.checks.includes(check));
  assert.equal(report.candidate.name, input.expected.name);
  assert.deepEqual(report.profiles, []);
  assert.ok(!JSON.stringify(report).includes(registry.origin) && !JSON.stringify(report).includes(input.directory));
  await assert.rejects(access(input.lifecycleMarker));
});

test("registry resolution admits exact semantic versions and rejects ranges or ambiguous prereleases before npm", async context => {
  const input = await packageFixture(context);
  const registry = await packageRegistry(context, input);
  for (const version of ["1", "1.2", "1.2.3-01", "01.2.3", "1.2.3-", "1.2.3+"]) {
    await assert.rejects(createRegistryPackageApplication({ registryPlan: registry.plan, expected: { ...input.expected, version } }), { code: "EVIDENCE_INVALID" });
  }
  assert.deepEqual(registry.requests, []);
});

test("acquisition freezes admitted metadata and never asks a variant to choose another archive", async context => {
  const input = await packageFixture(context);
  const variants = [];
  const registry = await packageRegistry(context, input, { response(request, response, { origin }) {
    if (request.url.endsWith(".tgz")) { response.end(input.bytes); return; }
    const full = request.headers.accept === "application/json";
    variants.push(full);
    response.writeHead(200, { "content-type": "application/json", vary: "accept" });
    response.end(JSON.stringify({ name: input.expected.name, "dist-tags": { latest: input.expected.version }, versions: {
      [input.expected.version]: { name: input.expected.name, version: input.expected.version,
        dist: { tarball: full ? `${origin}/p.tgz` : `file:${input.tarball}`, integrity: input.expected.tarball.integrity } },
    } }));
  } });
  const application = await createRegistryPackageApplication({ registryPlan: registry.plan, expected: input.expected });
  try {
    assert.equal(application.registry.status, "passed");
    assert.ok(variants.length > 0 && variants.every(Boolean));
    assert.equal(registry.requests.filter(request => request.url.endsWith(".tgz")).length, 1);
    assert.equal(application.registry.download.requests, 1);
  } finally { await application.close(); }
});

for (const tarball of ["file:/synthetic/unadmitted.tgz", "git+https://unadmitted.example.invalid/code.git", "https://user:secret@unadmitted.example.invalid/p.tgz"]) {
  test(`unsupported archive resolution rejects before package parsing: ${new URL(tarball).protocol}`, async context => {
    const input = await packageFixture(context);
    const registry = await packageRegistry(context, input, { metadata: { dist: { tarball, integrity: input.expected.tarball.integrity } } });
    await assert.rejects(createRegistryPackageApplication({ registryPlan: registry.plan, expected: input.expected }), { code: "REGISTRY_ENDPOINT_REJECTED" });
    assert.ok(!registry.requests.some(request => request.url.endsWith(".tgz")));
  });
}

for (const kind of ["redirect", "redirect-cycle", "overlong", "short", "declared-length", "content-encoding", "timeout"]) {
  test(`raw archive ${kind} fails before npm cache population`, async context => {
    const input = await packageFixture(context);
    const escaped = await packageRegistry(context, input);
    const registry = await packageRegistry(context, input, { response(request, response, { origin }) {
      if (!request.url.endsWith(".tgz")) {
        response.end(JSON.stringify({ name: input.expected.name, "dist-tags": { latest: input.expected.version }, versions: {
          [input.expected.version]: { name: input.expected.name, version: input.expected.version,
            dist: { tarball: `${origin}/p.tgz`, integrity: input.expected.tarball.integrity } },
        } }));
      } else if (kind === "redirect" || kind === "redirect-cycle") {
        response.writeHead(302, { location: kind === "redirect" ? `${escaped.origin}/p.tgz` : `${origin}/p.tgz` }); response.end();
      } else if (kind === "overlong" || kind === "short") {
        response.writeHead(200, { "transfer-encoding": "chunked" });
        response.end(kind === "short" ? input.bytes.subarray(0, 10) : Buffer.concat([input.bytes, Buffer.from("extra")]));
      } else if (kind === "declared-length" || kind === "content-encoding") {
        response.writeHead(200, kind === "declared-length" ? { "content-length": input.bytes.length + 10 } : { "content-encoding": "gzip" });
        response.end(input.bytes);
      }
      // timeout deliberately never completes the response.
    } });
    await assert.rejects(createRegistryPackageApplication({ registryPlan: { ...registry.plan, clientTimeoutMs: 3000 }, expected: input.expected }), error => {
      assert.equal(error.registry.phase, "registry-archive");
      assert.ok(error.registry.checks.includes("exact-registry-metadata"));
      assert.ok(!error.registry.checks.includes("approved-cache-population"));
      if (kind === "timeout") assert.equal(error.code, "REGISTRY_DOWNLOAD_TIMEOUT");
      else assert.equal(error.code, kind.startsWith("redirect") ? "REGISTRY_ENDPOINT_REJECTED"
        : ["declared-length", "content-encoding"].includes(kind) ? "REGISTRY_DOWNLOAD_FAILED" : "ARCHIVE_MISMATCH");
      return true;
    });
    assert.deepEqual(escaped.requests, []);
  });
}

test("npm rejects corrupted consumed cache even while its separate admitted archive copy is intact", async context => {
  const input = await packageFixture(context);
  const registry = await packageRegistry(context, input);
  const corrupt = `if(args[0]==='install'){const root=args[args.indexOf('--cache')+1]+'/_cacache/content-v2/sha512';for(const a of fs.readdirSync(root))for(const b of fs.readdirSync(root+'/'+a))for(const c of fs.readdirSync(root+'/'+a+'/'+b)){const p=root+'/'+a+'/'+b+'/'+c;const x=fs.readFileSync(p);if(x[0]===31&&x[1]===139)fs.appendFileSync(p,'changed');}}`;
  const wrapper = await npmWrapper(input, "", corrupt);
  await withEnvironment({ PATH: `${wrapper.directory}${delimiter}${process.env.PATH}` }, async () => {
    await assert.rejects(createRegistryPackageApplication({ registryPlan: registry.plan, expected: input.expected }), error => {
      assert.equal(error.code, "REGISTRY_CLIENT_FAILED");
      assert.equal(error.registry.phase, "registry-installation");
      assert.ok(error.registry.checks.includes("approved-cache-population"));
      return true;
    });
  });
  assert.equal(registry.requests.filter(request => request.url.endsWith(".tgz")).length, 1, "offline installation escaped to the registry");
  assert.deepEqual(await readFile(input.tarball), input.bytes);
});

test("an admitted archive redirect preserves exact bytes and private resolution originals", async context => {
  const input = await packageFixture(context);
  const target = await packageRegistry(context, input);
  const registry = await packageRegistry(context, input, { response(request, response, { origin }) {
    if (request.url.endsWith(".tgz")) { response.writeHead(302, { location: `${target.origin}/p.tgz` }); response.end(); }
    else response.end(JSON.stringify({ name: input.expected.name, "dist-tags": { latest: input.expected.version }, versions: {
      [input.expected.version]: { name: input.expected.name, version: input.expected.version,
        dist: { tarball: `${origin}/p.tgz`, integrity: input.expected.tarball.integrity } },
    } }));
  } });
  const application = await createRegistryPackageApplication({ registryPlan: { ...registry.plan, allowedOrigins: [registry.origin, target.origin] }, expected: input.expected });
  try {
    assert.deepEqual(await readFile(application.tarball), input.bytes);
    assert.equal(application.registry.download.requests, 2);
    assert.equal(application.registry.download.locations.length, 2);
    assert.deepEqual(application.privateRegistryEvidence.downloadURLs, [`${registry.origin}/p.tgz`, `${target.origin}/p.tgz`]);
    assert.ok(!JSON.stringify(application.registry).includes(registry.origin) && !JSON.stringify(application.registry).includes(target.origin));
  } finally { await application.close(); }
});

test("changing the repository npm selection does not silently qualify another cache client", async context => {
  const input = await packageFixture(context);
  const registry = await packageRegistry(context, input);
  const verifier = join(input.directory, "different-client-verifier");
  await mkdir(join(verifier, "scripts"), { recursive: true });
  for (const name of ["package-registry", "package-registry-transport", "package-artifact"]) {
    await writeFile(join(verifier, `scripts/${name}.mjs`), await readFile(resolve(`scripts/${name}.mjs`)));
  }
  await writeFile(join(verifier, ".node-version"), process.version.slice(1));
  await writeFile(join(verifier, "package.json"), '{"packageManager":"npm@11.1.1"}');
  const commands = join(input.directory, "different-client-commands"); await mkdir(commands);
  await writeFile(join(commands, "npm"), '#!/usr/bin/env node\nconsole.log("11.1.1");\n');
  await chmod(join(commands, "npm"), 0o755);
  const { createRegistryPackageApplication: otherClient } = await import(new URL(`file://${join(verifier, "scripts/package-registry.mjs")}`));
  await withEnvironment({ PATH: `${commands}${delimiter}${process.env.PATH}` }, async () => {
    await assert.rejects(otherClient({ registryPlan: registry.plan, expected: input.expected }), { code: "REGISTRY_CLIENT_UNQUALIFIED" });
  });
  assert.deepEqual(registry.requests, []);
});

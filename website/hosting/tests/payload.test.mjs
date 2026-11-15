import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inventory, preparePayload, verifyPayload, publicationOrigin, nativeHeaders } from "../scripts/payload.mjs";
import { acquirePredecessor, boundedBody } from "../scripts/predecessor.mjs";

const revision = "a".repeat(40), origin = "https://site.example.edu/";
/** @param {object} fixture @param {string[]} versions @returns {Promise<void>} */
async function documentation(fixture, versions) {
  const index = { schemaVersion: 1, stableVersion: versions.at(-1), renderingRevision: revision,
    versions: versions.map(version => ({ version, baselineRevision: revision, recordRevision: revision,
      recordSha256: "b".repeat(64), correction: null,
      documents: [{ source: "docs/README.md", route: `/docs/${version}/` }] })) };
  await writeFile(join(fixture.source, "documentation.json"), JSON.stringify(index));
  for (const version of versions) {
    const directory = join(fixture.source, "docs", version); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "index.html"), `<h1>Documentation ${version}</h1>`);
  }
  fixture.options.checked.files = await inventory(fixture.source);
}

test("updates and rollback reconstruct every documentation archive independently of asset retention", async context => {
  const first = await fixture(context, "one"); await documentation(first, ["0.3.0"]);
  const output1 = join(first.root, "delivery"); await preparePayload(first.source, output1, first.options);
  const previous1 = join(first.root, "previous");
  await acquirePredecessor(origin, first.source, previous1, async url => new Response(await readFile(join(output1, url.pathname))));
  const second = await fixture(context, "two"); await documentation(second, ["0.3.0", "0.4.0"]);
  const output2 = join(second.root, "delivery"); await preparePayload(second.source, output2, { ...second.options, previous: previous1 });
  const previous2 = join(second.root, "previous");
  await acquirePredecessor(origin, second.source, previous2, async url => new Response(await readFile(join(output2, url.pathname))));
  const third = await fixture(context, "three"); await documentation(third, ["0.3.0", "0.4.0", "0.5.0"]);
  const output3 = join(third.root, "delivery"); await preparePayload(third.source, output3, { ...third.options, previous: previous2 });
  assert.equal(await readFile(join(output3, "docs/0.3.0/index.html"), "utf8"), "<h1>Documentation 0.3.0</h1>");
  const previous3 = join(third.root, "previous");
  await acquirePredecessor(origin, third.source, previous3, async url => new Response(await readFile(join(output3, url.pathname))));
  await assert.rejects(preparePayload(first.source, join(first.root, "lost-archives"), { ...first.options, previous: previous3, rollback: true }), /archive/);
  const restored = await fixture(context, "restored"); await documentation(restored, ["0.3.0", "0.4.0", "0.5.0"]);
  await preparePayload(restored.source, join(restored.root, "delivery"), { ...restored.options, previous: previous3, rollback: true });
  const changed = JSON.parse(await readFile(join(restored.source, "documentation.json")));
  changed.versions[0].baselineRevision = "c".repeat(40);
  await writeFile(join(restored.source, "documentation.json"), JSON.stringify(changed));
  restored.options.checked.files = await inventory(restored.source);
  await assert.rejects(preparePayload(restored.source, join(restored.root, "changed-baseline"), { ...restored.options, previous: previous3 }), /baseline/);
});

/** @param {object} context @param {string} asset @returns {Promise<object>} */
async function fixture(context, asset = "one") {
  const root = await mkdtemp(join(tmpdir(), "tabgrad-hosting-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"); await mkdir(source);
  await writeFile(join(source, "index.html"), '<h1>Home</h1><script>window.home = true</script>');
  await writeFile(join(source, "404.html"), '<h1>Missing</h1><script>window.recovery = true</script>');
  await mkdir(join(source, "_astro"));
  await writeFile(join(source, `_astro/${asset}.js`), `export const value = '${asset}';`);
  const checked = { origin, revision, localChanges: false, files: await inventory(source) };
  return { root, source, checked, options: { origin, revision, checked, production: true } };
}

test("delivery is the exact checked output and rejects extra files, edits, links and changed identity", async context => {
  const { root, source, options } = await fixture(context);
  const destination = join(root, "delivery");
  const result = await preparePayload(source, destination, options);
  assert.equal((await verifyPayload(destination, { digest: result.digest, production: false })).digest, result.digest);
  await writeFile(join(destination, "extra.txt"), "not checked");
  await assert.rejects(verifyPayload(destination, { production: false }), /inventory/);
  await rm(join(destination, "extra.txt"));
  await writeFile(join(destination, "index.html"), "changed");
  await assert.rejects(verifyPayload(destination, { production: false }), /inventory/);
  await assert.rejects(verifyPayload(destination, { digest: "b".repeat(64), production: false }), /identity/);
  await symlink(source, join(root, "linked"));
  await assert.rejects(inventory(join(root, "linked")), /regular directory/);
  await writeFile(join(source, "_headers"), "unreviewed");
  await assert.rejects(preparePayload(source, join(root, "extra"), options), /inventory/);
});

test("retention is one predecessor, never a transitive archive; immutable conflicts fail", async context => {
  const first = await fixture(context, "one");
  const firstOutput = join(first.root, "delivery");
  await preparePayload(first.source, firstOutput, first.options);
  const firstPredecessor = join(first.root, "predecessor");
  await acquirePredecessor(origin, first.source, firstPredecessor, async url => new Response(await readFile(join(firstOutput, url.pathname))));
  const second = await fixture(context, "two");
  const secondOutput = join(second.root, "delivery");
  await preparePayload(second.source, secondOutput, { ...second.options, previous: firstPredecessor });
  const secondPredecessor = join(second.root, "predecessor");
  await acquirePredecessor(origin, second.source, secondPredecessor, async url => new Response(await readFile(join(secondOutput, url.pathname))));
  assert.equal(await readFile(join(secondOutput, "_astro/one.js"), "utf8"), "export const value = 'one';");
  const third = await fixture(context, "three");
  const thirdOutput = join(third.root, "delivery");
  const result = await preparePayload(third.source, thirdOutput, { ...third.options, previous: secondPredecessor });
  assert.ok(result.manifest.files.some(file => file.path === "_astro/two.js"));
  assert.ok(!result.manifest.files.some(file => file.path === "_astro/one.js"));
  await writeFile(join(third.source, "_astro/two.js"), "changed immutable bytes");
  third.options.checked.files = await inventory(third.source);
  await assert.rejects(preparePayload(third.source, join(third.root, "conflict"), { ...third.options, previous: secondPredecessor }), /Immutable URL/);
});

test("origin, source and bounded native rules fail closed", async context => {
  for (const value of [undefined, "http://example.invalid", "https://example.invalid", "https://example.com", "https://127.0.0.1", "https://host.invalid/path", "https://user:pass@host.invalid"]) assert.throws(() => publicationOrigin(value));
  const { root, source, options } = await fixture(context);
  await assert.rejects(preparePayload(source, join(root, "origin"), { ...options, origin: "https://other.invalid/" }), /origin/);
  await assert.rejects(preparePayload(source, join(root, "dirty"), { ...options, checked: { ...options.checked, localChanges: true } }), /clean source/);
  const preview = join(root, "preview");
  await preparePayload(source, preview, { ...options, production: false, checked: { ...options.checked, localChanges: true } });
  await assert.rejects(verifyPayload(preview), /nonpublishable/);
  await assert.rejects(preparePayload(source, join(source, "nested"), options), /independent/);
  const files = [];
  for (let index = 0; index < 101; index++) {
    const path = `page-${index}.html`;
    await writeFile(join(source, path), `<script>window.page = ${index};</script>`);
    files.push({ path });
  }
  await assert.rejects(nativeHeaders(source, files), /header-rule limit/);
});

test("predecessor acquisition reuses identical bytes and rejects changed, absent or oversized resources", async context => {
  const candidate = await fixture(context, "one");
  const payload = join(candidate.root, "delivery");
  await preparePayload(candidate.source, payload, candidate.options);
  const requests = [];
  await acquirePredecessor(origin, candidate.source, join(candidate.root, "same"), async url => {
    requests.push(url.pathname);
    return new Response(await readFile(join(payload, url.pathname)));
  });
  assert.deepEqual(requests, ["/website-delivery.json", "/website-delivery.json"], "unchanged immutable bytes do not need another download");
  const empty = join(candidate.root, "empty"); await mkdir(empty);
  for (const status of [200, 404]) {
    const target = join(candidate.root, `bad-${status}`);
    await assert.rejects(acquirePredecessor(origin, empty, target, async url => url.pathname === "/website-delivery.json"
      ? new Response(await readFile(join(payload, url.pathname))) : new Response("changed", { status })), /changed|unavailable/);
    await assert.rejects(readFile(join(target, "website-delivery.json")), /ENOENT/, "failed acquisition removes its owned partial result");
  }
  await assert.rejects(boundedBody(new Response("too many bytes"), 3), /budget/);
});

test("release manifests preserve separate source/recipe identity and explicit restoration keeps both runtime generations", async context => {
  const { root, source, checked, options } = await fixture(context);
  const identity = { schemaVersion: 1, completionSha256: "a".repeat(64), operation: "a".repeat(64), planSha256: "b".repeat(64),
    sourceRevision: options.revision, recipeRevision: "d".repeat(40), runId: "123", attempt: "1", version: "0.4.0",
    inventorySha256: "e".repeat(64), archiveSha512: "f".repeat(128) };
  const first = join(root, "manual-first"); await preparePayload(source, first, options);
  const firstPrevious = join(root, "manual-previous");
  await acquirePredecessor(origin, source, firstPrevious, async url => new Response(await readFile(join(first, url.pathname))));
  const released = join(root, "release-second");
  const result = await preparePayload(source, released, { ...options, previous: firstPrevious, checked: { ...checked, release: identity, recipeRevision: identity.recipeRevision } });
  assert.equal(result.manifest.format, 2); assert.deepEqual(result.manifest.release, identity);
  const releasePrevious = join(root, "release-previous");
  await acquirePredecessor(origin, source, releasePrevious, async url => new Response(await readFile(join(released, url.pathname))));
  const restored = join(root, "manual-third");
  await assert.rejects(preparePayload(source, restored, { ...options, previous: releasePrevious }), /explicitly authorize a rollback/);
  const restore = await preparePayload(source, restored, { ...options, previous: releasePrevious, rollback: true });
  assert.equal(restore.manifest.format, 1); assert.equal(restore.manifest.previous, result.digest);
  await assert.rejects(preparePayload(source, join(root, "bad-source"), { ...options, checked: { ...checked, release: { ...identity, sourceRevision: "invalid" } } }));
});

test("equal namespace policies share one native rule while preserving recovery and exact differing policies", async t => {
  const { source } = await fixture(t), files = [];
  for (let index = 0; index < 120; index++) {
    const path = `docs/0.3.0/page-${index}/index.html`;
    await mkdir(join(source, `docs/0.3.0/page-${index}`), { recursive: true });
    await writeFile(join(source, path), '<h1>Documentation</h1><script>window.recovery = true</script><script>window.docs = true</script>');
    files.push({ path });
  }
  const headers = await nativeHeaders(source, files);
  assert.ok(headers.includes('\n/docs/*\n'));
  assert.ok(!headers.includes('/docs/0.3.0/page-0/'));
  await writeFile(join(source, files[0].path), '<h1>Different policy</h1><script>window.recovery = true</script><script>window.unique = true</script>');
  await assert.rejects(nativeHeaders(source, files), /header-rule limit/);
});

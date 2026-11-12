import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inventory, preparePayload, verifyPayload, publicationOrigin, nativeHeaders } from "../scripts/payload.mjs";
import { acquirePredecessor, boundedBody } from "../scripts/predecessor.mjs";

const revision = "a".repeat(40), origin = "https://site.example.edu/";
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
  return { root, source, checked, options: { origin, revision, checked, production: false } };
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

import assert from "node:assert/strict";
import test from "node:test";
import { siteOrigin, socialHead, robotsTxt, articleStructuredData } from "../scripts/publication.mjs";
import { integrationFiles } from "../scripts/integration-files.mjs";
import { socialMarkup } from "../scripts/social-images.mjs";

test("a public origin is explicit, normalized and cannot carry private URL components", () => {
  assert.equal(siteOrigin(undefined), undefined);
  assert.equal(siteOrigin("https://example.invalid"), "https://example.invalid/");
  for (const input of ["", "not a url", "http://example.invalid", "https://user:password@example.invalid", "https://example.invalid/path", "https://example.invalid/?key=value", "https://example.invalid/#fragment"]) assert.throws(() => siteOrigin(input));
});

test("robots uses the supplied sitemap origin and leaves resources crawlable", () => {
  assert.equal(robotsTxt(undefined), "User-agent: *\nAllow: /\n");
  assert.equal(robotsTxt("https://example.invalid/"), "User-agent: *\nAllow: /\nSitemap: https://example.invalid/sitemap-index.xml\n");
});

test("article JSON-LD keeps actual metadata, dates and URLs without becoming executable HTML", () => {
  const post = { title: 'A </script><script>alert("x")</script> title', description: "A useful summary.", author: "Another author", date: "2026-11-11" };
  assert.equal(articleStructuredData(undefined, "first-post", post), undefined);
  const serialized = articleStructuredData("https://example.invalid/", "first-post", post);
  assert.ok(!serialized.includes("<"), "data cannot end its script element");
  const value = JSON.parse(serialized);
  assert.equal(value["@type"], "BlogPosting");
  assert.equal(value.headline, post.title);
  assert.equal(value.description, post.description);
  assert.deepEqual(value.author, { "@type": "Person", name: post.author });
  assert.equal(value.datePublished, post.date);
  assert.equal(value.url, "https://example.invalid/blog/first-post/");
  assert.equal(value.mainEntityOfPage, value.url);
  assert.equal(value.image, "https://example.invalid/social/article-first-post.png");
});

test("social metadata shares a real absolute origin and a per-article image", () => {
  assert.deepEqual(socialHead(undefined), []);
  const head = socialHead("https://example.invalid/", "/social/a-post.png", "A <title>");
  const values = Object.fromEntries(head.map(entry => [entry.attrs.property ?? entry.attrs.name, entry.attrs.content]));
  assert.equal(values["og:image"], "https://example.invalid/social/a-post.png");
  assert.equal(values["twitter:image"], values["og:image"]);
  assert.equal(values["og:image:alt"], "A <title>");
});

test("download filenames preserve both Python sources and wrap only the HTML body example", () => {
  const input = { integrationHtml: '<pre id="output"></pre>', integrationPythonHtml: "<!doctype html>\n<p>Python</p>", integrationPythonWorker: "const original = 1;\n" };
  const files = integrationFiles(input);
  assert.deepEqual(files.map(file => file.name), ["index.html", "index.html", "python-worker.js"]);
  assert.ok(files.every(file => file.path.endsWith(".txt")), "source downloads do not introduce executable website routes");
  assert.ok(files[0].body.includes(input.integrationHtml));
  assert.ok(files[0].body.startsWith("<!doctype html>"));
  assert.equal(files[1].body, input.integrationPythonHtml);
  assert.equal(files[2].body, input.integrationPythonWorker);
});

test("article text is escaped in share image markup rather than becoming HTML", () => {
  const html = socialMarkup({title:'A <script> & "quote"',description:"Test <img>",label:"Blog",art:"<svg/>"},{styles:"",logo:"<svg/>"});
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("A &lt;script&gt; &amp; &quot;quote&quot;"));
  assert.ok(html.includes("Test &lt;img&gt;"));
});

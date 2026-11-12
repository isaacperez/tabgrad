import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer";
import { parse } from "parse5";
import { websiteRoot, repositoryRoot } from "./config.mjs";
import { loadIllustration } from "./illustrations.mjs";
import { escapeHtml, sha256, writeChanged } from "./files.mjs";

/** Fixed 1200×630 share format, using the website's actual paint/type/spacing roles.
 * @param {{title:string,description:string,label:string,art:string}} card
 * @param {{styles:string,logo:string}} assets */
export function socialMarkup(card, assets) {
  return `<!doctype html><html lang="en" data-theme="light"><meta charset="utf-8"><style>
${assets.styles}
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--sl-font), sans-serif; }
.share-card { width: 1200px; height: 630px; padding: var(--tg-space-16); background: var(--paper); color: var(--ink); display: grid; grid-template-rows: auto minmax(0,1fr) auto; gap: var(--tg-space-8); }
.share-brand { display:flex; align-items:center; justify-content:space-between; gap:var(--tg-space-8); }
.share-brand svg { width:var(--tg-art-support-size); height:auto; }
.share-label { color:var(--muted); font-size:var(--tg-text-lead); }
.share-story { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(0,1fr); align-items:center; gap:var(--tg-space-12); min-height:0; }
.share-copy { min-width:0; max-height:100%; }
h1 { margin:0; font-size:var(--tg-text-display); line-height:var(--sl-line-height-headings); font-weight:600; letter-spacing:-0.035em; text-wrap:balance; }
p { margin:var(--tg-space-6) 0 0; color:var(--violet); font-size:var(--sl-text-2xl); line-height:var(--sl-line-height-headings); }
.share-footer { padding-top:var(--tg-space-4); border-top:1px solid var(--line); color:var(--muted); font-size:var(--tg-text-lead); }
</style><div class="share-card"><div class="share-brand">${assets.logo}<span class="share-label">${escapeHtml(card.label)}</span></div><div class="share-story"><div class="share-copy"><h1>${escapeHtml(card.title)}</h1><p>${escapeHtml(card.description)}</p></div>${card.art}</div><div class="share-footer">Python · JavaScript · CPU · GPU</div></div></html>`;
}

/** Generate local PNGs during preparation; visits never start a renderer.
 * @param {{id:string,title:string,description:string}[]} posts @param {string} output */
async function prepareSocialImages(posts, output) {
  const work = join(websiteRoot, ".generated/social");
  await mkdir(output, { recursive: true }); await mkdir(work, { recursive: true });
  let tokens = await readFile(join(websiteRoot, "src/styles/tokens.css"), "utf8");
  for (const font of ["InterVariable.woff2", "InterVariable-Italic.woff2"]) {
    const data = await readFile(join(websiteRoot, "src/assets/fonts", font));
    tokens = tokens.replace(`../assets/fonts/${font}`, `data:font/woff2;base64,${data.toString("base64")}`);
  }
  const props = await readFile(join(websiteRoot, "node_modules/@astrojs/starlight/dist/style/props.css"), "utf8");
  const paint = await readFile(join(websiteRoot, "src/styles/illustrations.css"), "utf8");
  const logo = await readFile(join(repositoryRoot, "assets/brand/tabgrad-logo.svg"), "utf8");
  const art = await loadIllustration("browser");
  const assets = { styles: props + tokens + paint, logo };
  const cards = [
    { id: "tabgrad", title: "PyTorch code in your browser.", description: "Nothing to install.", label: "", art },
    ...posts.map(post => ({ ...post, id: `article-${post.id}`, label: "Blog", art })),
  ];
  let previous = {};
  try { previous = JSON.parse(await readFile(join(work, "cache.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const renderer = JSON.parse(await readFile(join(websiteRoot, "node_modules/puppeteer/package.json"), "utf8"));
  const next = {};
  let browser;
  try {
    for (const card of cards) {
      const html = socialMarkup(card, assets);
      const key = sha256(html + renderer.version + process.platform + process.arch);
      const file = join(output, `${card.id}.png`);
      try {
        const bytes = await readFile(join(work, `${card.id}.png`));
        if (previous[card.id]?.key === key && previous[card.id].sha256 === sha256(bytes)) { await writeFile(file, bytes); next[card.id] = previous[card.id]; continue; }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      browser ??= await puppeteer.launch({ headless: true });
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
        await page.setRequestInterception(true);
        page.on("request", request => request.url().startsWith("data:") ? request.continue() : request.abort());
        await page.setContent(html, { waitUntil: "load" });
        await page.evaluate(() => document.fonts.ready);
        const fits = await page.evaluate(() => {
          const copy = document.querySelector(".share-copy"), story = document.querySelector(".share-story");
          return copy.scrollHeight <= Math.ceil(story.getBoundingClientRect().height) && copy.scrollWidth <= copy.clientWidth;
        });
        if (!fits) throw new Error(`Social image text does not fit: ${card.id}`);
        const bytes = await page.screenshot({ type: "png" });
        await writeFile(file, bytes);
        await writeFile(join(work, `${card.id}.png`), bytes);
        await writeChanged(join(work, `${card.id}.html`), html);
        next[card.id] = { key, sha256: sha256(bytes) };
      } finally { await page.close(); }
    }
  } finally { await browser?.close(); }
  for (const file of await readdir(output)) if (!cards.some(card => `${card.id}.png` === file)) await rm(join(output, file));
  for (const file of await readdir(work)) if (/\.(html|png)$/.test(file) && !cards.some(card => file === `${card.id}.html` || file === `${card.id}.png`)) await rm(join(work, file));
  await writeChanged(join(work, "cache.json"), JSON.stringify(next, null, 2) + "\n");
}

/** Read native Astro's validated/rendered metadata, not a second YAML parser.
 * @param {object} node @param {Map<string,string>} values */
function collectMetadata(node, values) {
  if (node.tagName === "meta") {
    const attrs = Object.fromEntries(node.attrs.map(attribute => [attribute.name, attribute.value]));
    if (attrs.property) values.set(attrs.property, attrs.content);
  }
  for (const child of node.childNodes ?? []) collectMetadata(child, values);
}

/** The post-build hook sees final article metadata after native schema validation.
 * @param {string} root */
export async function prepareOutputSocialImages(root) {
  const { posts } = JSON.parse(await readFile(join(websiteRoot, ".generated/site-data.json"), "utf8"));
  const cards = [];
  for (const post of posts) {
    const metadata = new Map();
    collectMetadata(parse(await readFile(join(root, post.route, "index.html"), "utf8")), metadata);
    const title = metadata.get("og:title"), description = metadata.get("og:description");
    if (!title || !description) throw new Error(`Missing native article metadata: ${post.id}`);
    cards.push({ id: post.id, title, description });
  }
  await prepareSocialImages(cards, join(root, "social"));
}

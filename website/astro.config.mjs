import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { responsiveTables } from "./scripts/table-layout.mjs";
import { unified } from "@astrojs/markdown-remark";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { prepareContent } from "./scripts/prepare-content.mjs";
import { watchGitIndex } from "./scripts/source-watch.mjs";
import { websiteRoot, repositoryRoot, setupNavigation, referenceNavigation } from "./scripts/config.mjs";
import { siteOrigin, socialHead } from "./scripts/publication.mjs";
import { prepareOutputSocialImages } from "./scripts/social-images.mjs";
import { fileURLToPath } from "node:url";

const site = siteOrigin(process.env.TABGRAD_SITE_URL);

let refreshing = null;
let requested = false;
// Static code titles and source share one inset from the site's spacing scale.
const codePaddingInline = "var(--tg-space-4)";

/** Coalesce edits while diagram preparation is active without dropping the last edit. */
async function prepareQueuedContent(server) {
  try {
    while (requested) { requested = false; await prepareContent(); }
    server.ws.send({ type: "full-reload" });
  } catch (error) {
    server.ws.send({ type: "error", err: { message: error.message, stack: "", plugin: "Tabgrad documentation" } });
  } finally { refreshing = null; }
}

function refreshContent(server) {
  requested = true;
  if (!refreshing) refreshing = prepareQueuedContent(server);
}

function documentationRefresh() {
  let indexWatcher = null;
  return {
    name: "tabgrad-repository-documentation",
    closeBundle() { indexWatcher?.close(); },
    configureServer(server) {
      const docs = join(repositoryRoot, "docs");
      const blog = join(websiteRoot, "content/blog");
      const overviewArtwork = join(websiteRoot, "src/assets/illustrations/learning.svg");
      const index = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
      indexWatcher?.close();
      indexWatcher = watchGitIndex(index, () => refreshContent(server));
      indexWatcher.on("error", (error) => server.ws.send({ type: "error", err: { message: error.message, stack: "", plugin: "Tabgrad source admission" } }));
      server.httpServer?.once("close", () => indexWatcher.close());
      server.watcher.add([docs, blog, join(repositoryRoot, "README.md"), overviewArtwork]);
      server.watcher.on("all", (_event, file) => {
        if (!(file.startsWith(docs + "/") || file.startsWith(blog + "/") || file === join(repositoryRoot, "README.md") || file === overviewArtwork)) return;
        refreshContent(server);
      });
    },
  };
}

export default defineConfig({
  site,
  output: "static",
  devToolbar: { enabled: false },
  markdown: { processor: unified({ smartypants: false, rehypePlugins: [responsiveTables] }) },
  integrations: [{
    name: "tabgrad-documentation-routes",
    hooks: {
      "astro:config:setup": ({ addWatchFile }) => addWatchFile(new URL("./.generated/routes.json", import.meta.url)),
      "astro:build:done": ({ dir }) => prepareOutputSocialImages(fileURLToPath(dir)),
    },
  }, starlight({
    title: "Tabgrad",
    head: [{ tag: "meta", attrs: { property: "og:type", content: "website" } }, ...socialHead(site)],
    disable404Route: true,
    description: "Run Python or JavaScript calculations in your browser, without a local installation. Tabgrad independently implements a documented subset of PyTorch.",
    favicon: "/brand/tabgrad-small.svg",
    customCss: ["./src/styles/site.css"],
    components: { Header: "./src/components/Header.astro", ThemeSelect: "./src/components/ThemeAppearance.astro", MobileMenuToggle: "./src/components/MobileMenuToggle.astro", PageTitle: "./src/components/PageTitle.astro", Footer: "./src/components/Footer.astro" },
    sidebar: [
      { label: "Start here", items: [
        { label: "Documentation", slug: "docs" },
        { label: "Get started", link: "/start/" },
        ...setupNavigation.map(([name, label]) => ({ label, slug: `docs/reference/${name}` })),
      ] },
      { label: "API reference", collapsed: true, items: [
        { label: "JavaScript API", slug: "docs/javascript-api" },
        ...referenceNavigation.map(([name, label]) => ({ label, slug: `docs/reference/${name}` })),
        { label: "Compatibility", slug: "docs/compatibility" },
      ] },
      ...["concepts", "architecture", "components", "flows"].map((name) => ({
        label: name[0].toUpperCase() + name.slice(1), collapsed: true, items: [{ autogenerate: { directory: `docs/${name}` } }],
      })),
    ],
    social: [{ icon: "github", label: "GitHub", href: "https://github.com/isaacperez/tabgrad" }],
    tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
    expressiveCode: {
      themes: ["github-dark-high-contrast"],
      styleOverrides: {
        codeFontSize: "var(--sl-text-code)",
        codePaddingBlock: "var(--tg-space-6)",
        codePaddingInline,
        uiPaddingBlock: "var(--tg-space-3)",
        uiPaddingInline: codePaddingInline,
        borderRadius: "var(--tg-radius-lg)",
        frames: {
          frameBoxShadowCssValue: "none",
          editorActiveTabIndicatorHeight: "0",
          editorActiveTabBorderColor: "transparent",
          editorTabBorderRadius: "var(--tg-radius-lg)",
        },
      },
    },
    lastUpdated: false,
  })],
  vite: {
    plugins: [documentationRefresh()],
    server: { fs: { strict: true, allow: [websiteRoot] } },
    build: { sourcemap: false },
  },
});

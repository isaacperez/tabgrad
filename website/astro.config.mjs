import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { unified } from "@astrojs/markdown-remark";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { prepareContent } from "./scripts/prepare-content.mjs";
import { watchGitIndex } from "./scripts/source-watch.mjs";
import { websiteRoot, repositoryRoot, referenceNavigation } from "./scripts/config.mjs";

let refreshing = null;
let requested = false;

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
      const overviewArtwork = join(websiteRoot, "src/assets/illustrations/learning.svg");
      const index = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
      indexWatcher?.close();
      indexWatcher = watchGitIndex(index, () => refreshContent(server));
      indexWatcher.on("error", (error) => server.ws.send({ type: "error", err: { message: error.message, stack: "", plugin: "Tabgrad source admission" } }));
      server.httpServer?.once("close", () => indexWatcher.close());
      server.watcher.add([docs, join(repositoryRoot, "README.md"), overviewArtwork]);
      server.watcher.on("all", (_event, file) => {
        if (!(file.startsWith(docs + "/") || file === join(repositoryRoot, "README.md") || file === overviewArtwork)) return;
        refreshContent(server);
      });
    },
  };
}

export default defineConfig({
  output: "static",
  devToolbar: { enabled: false },
  markdown: { processor: unified({ smartypants: false }) },
  integrations: [{
    name: "tabgrad-documentation-routes",
    hooks: { "astro:config:setup": ({ addWatchFile }) => addWatchFile(new URL("./.generated/routes.json", import.meta.url)) },
  }, starlight({
    title: "Tabgrad",
    description: "Run PyTorch-style Python or JavaScript in your browser. Try the examples without installing anything locally.",
    favicon: "/brand/tabgrad-small.svg",
    customCss: ["./src/styles/site.css"],
    components: { Header: "./src/components/Header.astro", MobileMenuToggle: "./src/components/MobileMenuToggle.astro", PageTitle: "./src/components/PageTitle.astro", Footer: "./src/components/Footer.astro" },
    sidebar: [
      { label: "Start here", items: [
        { label: "Documentation", slug: "docs" },
        { label: "Python in the browser", slug: "docs/concepts/python-in-the-browser" },
        { label: "Browser installation", slug: "docs/reference/browser-package" },
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
        codePaddingInline: "var(--tg-space-6)",
        uiPaddingBlock: "var(--tg-space-3)",
        uiPaddingInline: "var(--tg-space-6)",
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

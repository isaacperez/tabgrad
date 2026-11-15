import type { PagefindUI, SearchResult } from "@pagefind/default-ui";

/** Result labels keep an explicit cross-version search understandable. */
function labelVersion(result: SearchResult): SearchResult {
  const path = new URL(result.url, location.origin).pathname;
  const version = /^\/docs\/(\d+\.\d+\.\d+)\//.exec(path)?.[1];
  if (version && !result.meta.title.startsWith(`v${version} · `)) result.meta.title = `v${version} · ${result.meta.title}`;
  return result;
}

class VersionedSearch extends HTMLElement {
  #dialog: HTMLDialogElement;
  #opener: HTMLButtonElement;
  #status: HTMLElement;
  #ui: PagefindUI | undefined;
  #initialization: Promise<void> | undefined;

  constructor() {
    super();
    this.#dialog = this.querySelector("dialog")!;
    this.#opener = this.querySelector("[data-open-modal]")!;
    this.#status = this.querySelector("[data-search-status]")!;
    this.#opener.addEventListener("click", () => this.#show());
    this.querySelector("[data-close-modal]")!.addEventListener("click", () => this.#dialog.close());
    this.querySelector("[data-search-scope]")!.addEventListener("change", () => this.#filter());
    this.#dialog.addEventListener("close", () => {
      document.body.removeAttribute("data-search-modal-open");
      this.#opener.focus();
    });
    this.#dialog.addEventListener("click", event => {
      if (event.target === this.#dialog || event.target instanceof Element && event.target.closest("a")) this.#dialog.close();
    });
    window.addEventListener("keydown", this.#shortcut);
  }

  disconnectedCallback(): void {
    window.removeEventListener("keydown", this.#shortcut);
    this.#ui?.destroy();
  }

  #shortcut = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
    event.preventDefault();
    if (this.#dialog.open) this.#dialog.close();
    else this.#show();
  };

  #show(): void {
    if (!this.#dialog.open) this.#dialog.showModal();
    document.body.setAttribute("data-search-modal-open", "true");
    this.#initialization ??= this.#prepare();
    this.querySelector<HTMLInputElement>("input")?.focus();
  }

  #filter(): void {
    const scope = this.querySelector<HTMLSelectElement>("[data-search-scope]")!.value;
    this.#ui?.triggerFilters({ scope: scope ? [scope] : [] });
  }

  async #prepare(): Promise<void> {
    try {
      const { PagefindUI } = await import("@pagefind/default-ui");
      if (!this.isConnected) return;
      this.#ui = new PagefindUI({ element: "#starlight__search", bundlePath: "/pagefind/", showImages: false,
        showSubResults: true, processResult: labelVersion });
      this.#filter();
      this.#status.hidden = true;
      if (this.#dialog.open) this.querySelector<HTMLInputElement>("input")?.focus();
    } catch (error) {
      this.#status.textContent = "Search could not load. Reload the page to try again.";
      console.error("Search initialization failed", error);
    }
  }
}

if (!customElements.get("site-search")) customElements.define("site-search", VersionedSearch);

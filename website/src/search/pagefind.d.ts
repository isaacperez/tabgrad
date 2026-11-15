declare module "@pagefind/default-ui" {
  export interface SearchResult {
    url: string;
    meta: { title: string; [key: string]: string };
    sub_results: { url: string; title: string }[];
  }
  export class PagefindUI {
    constructor(options: {
      element: string;
      bundlePath: string;
      showImages: boolean;
      showSubResults: boolean;
      processResult: (result: SearchResult) => SearchResult;
    });
    triggerFilters(filters: Record<string, string[]>): void;
    destroy(): void;
  }
}

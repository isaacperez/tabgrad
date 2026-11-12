// Narrow boundary for the untyped Prism components used by the editable view.
// Token rendering stays text-only; browser integration checks the real grammars.
declare module "prismjs/components/prism-core.js" {
  export interface Token {
    type: string;
    content: string | Token | (string | Token)[];
    alias?: string | string[];
  }
  export type Grammar = Record<string, unknown>;
  const Prism: {
    manual: boolean;
    languages: Record<string, Grammar>;
    tokenize(code: string, grammar: Grammar): (string | Token)[];
  };
  export default Prism;
}
declare module "prismjs/components/prism-clike.js";
declare module "prismjs/components/prism-javascript.js";
declare module "prismjs/components/prism-python.js";

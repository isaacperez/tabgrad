import Prism, { type Token } from "prismjs/components/prism-core.js";
import "prismjs/components/prism-clike.js";
import "prismjs/components/prism-javascript.js";
import "prismjs/components/prism-python.js";

Prism.manual = true;

function appendToken(document: Document, parent: Node, token: string | Token): void {
  if (typeof token === "string") { parent.appendChild(document.createTextNode(token)); return; }
  const span = document.createElement("span");
  span.classList.add("token", token.type);
  if (token.alias) span.classList.add(...(Array.isArray(token.alias) ? token.alias : [token.alias]));
  const content = Array.isArray(token.content) ? token.content : [token.content];
  for (const child of content) appendToken(document, span, child);
  parent.appendChild(span);
}

/** The textarea owns source, selection and input. This view only paints colors. */
export class SyntaxEditor {
  constructor(private input: HTMLTextAreaElement, private layer: HTMLPreElement, private notice: HTMLParagraphElement) {
    input.addEventListener("scroll", () => this.align());
  }

  paint(language: "python" | "javascript"): void {
    try {
      const grammar = Prism.languages[language];
      if (!grammar) throw new Error(`Missing syntax grammar: ${language}`);
      const fragment = this.input.ownerDocument.createDocumentFragment();
      for (const token of Prism.tokenize(this.input.value, grammar)) appendToken(this.input.ownerDocument, fragment, token);
      this.layer.replaceChildren(fragment);
      this.input.classList.add("syntax-ready");
      this.notice.hidden = true;
      this.notice.removeAttribute("title");
    } catch (error) {
      this.input.classList.remove("syntax-ready");
      this.layer.replaceChildren();
      this.notice.textContent = "Syntax colors unavailable. Editing and execution still work.";
      this.notice.title = String(error);
      this.notice.hidden = false;
    }
    this.resize();
  }

  resize(): void {
    this.input.style.height = "auto";
    const style = getComputedStyle(this.input);
    const borderHeight = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    this.input.style.height = `${this.input.scrollHeight + borderHeight}px`;
    this.align();
  }

  private align(): void {
    const style = getComputedStyle(this.input);
    const bounds = this.input.getBoundingClientRect();
    const verticalScrollbar = this.input.offsetWidth - this.input.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
    const horizontalScrollbar = this.input.offsetHeight - this.input.clientHeight - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
    this.layer.style.width = `${bounds.width - verticalScrollbar}px`;
    this.layer.style.height = `${bounds.height - horizontalScrollbar}px`;
    this.layer.scrollTop = this.input.scrollTop;
    this.layer.scrollLeft = this.input.scrollLeft;
  }
}

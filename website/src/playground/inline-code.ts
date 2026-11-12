export interface InlineCodePart {
  text: string;
  code: boolean;
}

/** Editorial prose supports single-backtick code spans, not HTML or full Markdown. */
export function inlineCodeParts(text: string): InlineCodePart[] {
  const parts = text.split("`");
  if (parts.length % 2 === 0) throw new Error("Unclosed inline code span.");
  return parts
    .map((value, index) => {
      const code = index % 2 === 1;
      if (code && (!value || value.includes("\n")))
        throw new Error("Inline code must be nonempty and stay on one line.");
      return { text: value, code };
    })
    .filter((part) => part.text.length > 0);
}

/** Replace a dynamic explanation using only text nodes and literal code elements. */
export function setInlineCode(element: Element, text: string): void {
  element.replaceChildren(
    ...inlineCodeParts(text).map((part) => {
      if (!part.code) return element.ownerDocument.createTextNode(part.text);
      const code = element.ownerDocument.createElement("code");
      code.textContent = part.text;
      return code;
    }),
  );
}

import assert from "node:assert/strict";
import test from "node:test";
import { inlineCodeParts, setInlineCode } from "../src/playground/inline-code.ts";

test("explanations preserve prose and identify explicit code references", () => {
  assert.deepEqual(inlineCodeParts("Change `x` or `y`, then compare `dx`."), [
    { text: "Change ", code: false }, { text: "x", code: true },
    { text: " or ", code: false }, { text: "y", code: true },
    { text: ", then compare ", code: false }, { text: "dx", code: true },
    { text: ".", code: false },
  ]);
  assert.deepEqual(inlineCodeParts("Two inputs, one result."), [{ text: "Two inputs, one result.", code: false }]);
  for (const invalid of ["`unclosed", "empty `` code", "`two\nlines`"]) assert.throws(() => inlineCodeParts(invalid), /inline code/i);
});

test("dynamic explanations create text and code nodes without interpreting HTML", () => {
  const document = {
    createTextNode(text) { return { type: "text", textContent: text }; },
    createElement(name) { return { type: name, textContent: "" }; },
  };
  const target = { ownerDocument: document, replaceChildren(...nodes) { this.nodes = nodes; }, set innerHTML(_) { throw new Error("HTML must not be parsed"); } };
  setInlineCode(target, 'Read `<img onerror="bad()">`, not <script>.');
  assert.deepEqual(target.nodes.map(node => node.type), ["text", "code", "text"]);
  assert.equal(target.nodes.map(node => node.textContent).join(""), 'Read <img onerror="bad()">, not <script>.');
  setInlineCode(target, "Another example.");
  assert.deepEqual(target.nodes, [{ type: "text", textContent: "Another example." }]);
});

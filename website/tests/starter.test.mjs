import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { firstCodeBlock } from "../scripts/content.mjs";

const guide = await readFile(new URL("../../docs/reference/browser-package.md", import.meta.url), "utf8");
const html = firstCodeBlock(guide, "html");
const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const entry = "https://cdn.jsdelivr.net/npm/@tabgrad/tabgrad@0.3.0/dist/index.js";

// Execute the documented module unchanged except for its import destination.
// The controlled module implements the public session contract and faults each
// acquisition/observation/closure boundary, without acquiring a real backend.
test("the HTML starter reports failures visibly and retains original diagnostics", async context => {
  const previous = { document: globalThis.document, state: globalThis.__starterState, error: console.error };
  context.after(() => {
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
    if (previous.state === undefined) delete globalThis.__starterState; else globalThis.__starterState = previous.state;
    console.error = previous.error;
  });
  for (const fault of ["none", "import", "session", "tensor", "sum", "read", "close", "read+close"]) {
    const original = new Error(`controlled ${fault}`);
    const cleanup = new Error("controlled cleanup");
    const output = { textContent: "Loading Tabgrad…" };
    const errors = [];
    let closed = 0;
    globalThis.document = { getElementById: () => output };
    console.error = (...values) => errors.push(...values);
    const result = { close() {}, async toArray() { if (fault.startsWith("read")) throw original; return [6]; } };
    const tensor = { close() {}, sum() { if (fault === "sum") throw original; return result; } };
    const session = { tensor() { if (fault === "tensor") throw original; return tensor; }, async close() { closed++; if (fault.includes("close")) throw cleanup; } };
    globalThis.__starterState = { original, session, fault };
    const moduleSource = `const state = globalThis.__starterState;
if (state.fault === "import") throw state.original;
export function createRuntimeSession() { if (state.fault === "session") throw state.original; return state.session; }`;
    const moduleUrl = `data:text/javascript,${encodeURIComponent(moduleSource)}#${randomUUID()}`;
    let unhandled;
    try { await import(`data:text/javascript,${encodeURIComponent(source.replace(entry, moduleUrl))}#${randomUUID()}`); }
    catch (error) { unhandled = error; }
    assert.equal(unhandled, undefined, `${fault}: failure must be presented by the example`);
    assert.equal(closed, ["import", "session"].includes(fault) ? 0 : 1, `${fault}: every acquired session closes once`);
    if (fault === "none") assert.equal(output.textContent, "Sum: 6");
    else {
      assert.notEqual(output.textContent, "Loading Tabgrad…", `${fault}: never leave a failed operation looking busy`);
      assert.match(output.textContent, /could not/i);
      if (!["close"].includes(fault)) assert.ok(errors.includes(original), `${fault}: original failure is preserved`);
      if (fault.includes("close")) assert.ok(errors.includes(cleanup), `${fault}: cleanup failure is preserved too`);
    }
  }
});

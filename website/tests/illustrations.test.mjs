import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadIllustration, illustrationNames } from "../scripts/illustrations.mjs";
import { checkDiagram } from "../scripts/verify-output.mjs";

test("owned inline illustrations are inert and safe to repeat within a page", async () => {
  for (const name of illustrationNames) {
    const markup = await loadIllustration(name);
    assert.match(markup, /aria-hidden="true"/);
    assert.match(markup, /viewBox=/);
    assert.doesNotMatch(markup, /\bid\s*=|\burl\(|<style\b/);
    checkDiagram(markup, name);
  }
  await assert.rejects(loadIllustration("../config.mjs"), /Unknown website illustration/);
});

test("every runnable example has artwork and an explicitly original explanatory diagram", async () => {
  const examples = JSON.parse(await readFile(new URL("../src/playground/examples.json", import.meta.url), "utf8"));
  for (const example of examples) {
    await loadIllustration(example.id);
    assert.ok(example.diagram.formula && example.diagram.explanation);
    assert.ok(example.diagram.terms.length && example.diagram.terms.every(term => term.label && term.value));
  }
});

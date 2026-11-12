import assert from "node:assert/strict";
import test from "node:test";
import { diagramSize, sizeDiagramImages } from "../scripts/diagram-layout.mjs";

test("diagram size comes from the authored viewBox, not percentage width or a minimum", () => {
  assert.deepEqual(diagramSize('<svg width="100%" viewBox="4 4 501.65625 806.8938"></svg>'), { width: 502, height: 807 });
  assert.deepEqual(diagramSize('<svg viewBox="-20,-10,80,40"></svg>'), { width: 80, height: 40 });
  for (const value of ["", "0 0 0 40", "0 0 -1 2", "0 0 Infinity 3", "0 0 1", "0 0 1 2 3"]) {
    assert.throws(() => diagramSize(`<svg viewBox="${value}"></svg>`), /viewBox/);
  }
  assert.throws(() => diagramSize('<p>Not SVG</p>'), /viewBox/);
});

test("generated images retain their asset identity and alternative text when sized", () => {
  const id = "a".repeat(64);
  const markup = `<img src="/diagrams/${id}.svg" alt="Input to output" loading="lazy">`;
  assert.equal(sizeDiagramImages(markup, new Map([[id, { width: 502, height: 807 }]])),
    `<img src="/diagrams/${id}.svg" width="502" height="807" alt="Input to output" loading="lazy">`);
  assert.throws(() => sizeDiagramImages(markup, new Map()), /Missing generated diagram dimensions/);
});

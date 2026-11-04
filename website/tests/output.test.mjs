import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDiagram } from "../scripts/verify-output.mjs";

test("diagrams reject active HTML, handlers, external resources and style imports", () => {
  checkDiagram('<svg><text>Readable label</text><use href="#label"/></svg>', "safe.svg");
  for (const source of ['<svg><foreignObject/></svg>', '<svg><script/></svg>', '<svg onload="x()"/>', '<svg><image href="https://example.invalid/a.png"/></svg>', '<svg><style>@import "remote.css";</style></svg>']) {
    assert.throws(() => checkDiagram(source, "bad.svg"), /Active|External/);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDiagram, checkExecutor } from "../scripts/verify-output.mjs";
import { sha256 } from "../scripts/files.mjs";

test("diagrams reject active HTML, handlers, external resources and style imports", () => {
  checkDiagram('<svg><text>Readable label</text><use href="#label"/></svg>', "safe.svg");
  for (const source of ['<svg><foreignObject/></svg>', '<svg><script/></svg>', '<svg onload="x()"/>', '<svg><image href="https://example.invalid/a.png"/></svg>', '<svg><style>@import "remote.css";</style></svg>']) {
    assert.throws(() => checkDiagram(source, "bad.svg"), /Active|External/);
  }
});

test("immutable executor URLs must identify their actual bytes", () => {
  const source = Buffer.from("self.onmessage = () => {};\n");
  const url = `/playground/executor-${sha256(source)}.worker.js`;
  checkExecutor(source, url);
  assert.throws(() => checkExecutor(Buffer.concat([source, Buffer.from("// changed")]), url), /Executor bytes/);
  assert.throws(() => checkExecutor(source, "/playground/executor.worker.js"), /Executor bytes/);
  assert.throws(() => checkExecutor(source, "/elsewhere/" + url.split("/").at(-1)), /Executor bytes/);
});

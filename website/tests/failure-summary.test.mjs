import assert from "node:assert/strict";
import test from "node:test";
import { failureSummary } from "../src/playground/failure-summary.ts";

test("ordinary and unknown error formats retain their actual first line", () => {
  assert.equal(failureSummary("TypeError: bad input\n    at example.js:4"), "TypeError: bad input");
  assert.equal(failureSummary("\n  plain failure\nmore detail"), "plain failure");
  assert.equal(failureSummary(""), "The run failed.");
  assert.equal(failureSummary("PythonError: unknown format\nraw detail"), "PythonError: unknown format");
});

test("Python headlines preserve the exception and point to the user's call", () => {
  const trace = 'PythonError: Traceback (most recent call last):\n  File "<playground>", line 4, in <module>\n    make_tensor()\n  File "/runtime.py", line 20, in make_tensor\n    raise RuntimeError("explicit dtype required")\nRuntimeError: explicit dtype required\n\n    at new_error (runtime.js:1)';
  assert.equal(failureSummary(trace), "RuntimeError: explicit dtype required (line 4)");
});

test("custom multiline exceptions and syntax errors keep a meaningful headline", () => {
  assert.equal(failureSummary('PythonError: Traceback (most recent call last):\n  File "<playground>", line 2\nAppProblem: first line\ncontinuation'), "AppProblem: first line (line 2)");
  assert.equal(failureSummary('PythonError: Traceback (most recent call last):\n  File "<playground>", line 3\n    x = (\n        ^\nSyntaxError: unclosed parenthesis'), "SyntaxError: unclosed parenthesis (line 3)");
});

test("chained traces use the final exception and do not invent a user frame", () => {
  const trace = 'PythonError: Traceback (most recent call last):\n  File "<playground>", line 1\nValueError: first\n\nDuring handling of the above exception:\n\nTraceback (most recent call last):\n  File "<playground>", line 7\nRuntimeError: final';
  assert.equal(failureSummary(trace), "RuntimeError: final (line 7)");
  assert.equal(failureSummary('PythonError: Traceback (most recent call last):\n  File "/runtime.py", line 1\nImportError: unavailable'), "ImportError: unavailable");
  assert.equal(failureSummary("PythonError: Traceback (most recent call last):\n    at runtime.js:1"), "PythonError: Traceback (most recent call last):");
});

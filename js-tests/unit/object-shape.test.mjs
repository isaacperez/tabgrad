import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecord } from "../../dist/shared/object-shape.js";

test("object shape accepts non-array objects without requiring a plain prototype", () => {
  class Diagnostic { message = "failure"; }
  const accepted = [
    {},
    { message: "failure" },
    Object.create(null),
    new Error("failure"),
    new Diagnostic(),
    new Uint8Array(0),
  ];
  for (const value of accepted) assert.equal(isRecord(value), true);
});

test("object shape rejects null, arrays, primitives and callable values", () => {
  const rejected = [
    null, undefined, [], [1], "failure", 0, NaN, true, 1n, Symbol("failure"),
    () => undefined, function diagnostic() {}, class Diagnostic {},
  ];
  for (const value of rejected) assert.equal(isRecord(value), false);
});

test("object shape does not read fields or invoke coercion hooks", () => {
  const value = Object.defineProperties({}, {
    message: { get() { assert.fail("shape checks must not read protocol fields"); } },
    [Symbol.toPrimitive]: { value() { assert.fail("shape checks must not coerce objects"); } },
  });
  assert.equal(isRecord(value), true);
});

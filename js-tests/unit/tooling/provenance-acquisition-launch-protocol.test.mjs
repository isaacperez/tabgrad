import assert from "node:assert/strict";
import test from "node:test";
import { createLaunchControlDecoder, encodeLaunchObservation } from "../../../scripts/provenance-acquisition-launch-protocol.mjs";

const op = "a".repeat(32), hash = "b".repeat(64);
const expected = { operationId: op, profileSha256: hash };
const wire = tail => Buffer.from(`TGL1|${op}|${hash}|${tail}\n`);
const normal = ["R|1|12|-|0|-|-|oo|-|-", "S|2|12|13|1|-|-|oo|-|-", "X|3|12|13|1|0|-|cc|-|-", "E|4|12|13|1|0|-|cc|-|-"];
const decode = lines => { const d = createLaunchControlDecoder(expected); for (const l of lines) d.push(wire(l)); return d.finish(); };

test("literal independent vectors, every chunk split, and exact encoder", () => {
  const bytes = Buffer.concat(normal.map(wire));
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = createLaunchControlDecoder(expected);
    decoder.push(bytes.subarray(0, split)); decoder.push(bytes.subarray(split));
    assert.equal(decoder.finish().observations.X.exitCode, 0);
  }
  const result = decode(normal);
  assert.deepEqual(encodeLaunchObservation(result.observations.R), wire(normal[0]));
  assert.ok(Object.isFrozen(result.observations.E));
});

test("F before readiness, settled spawn throw, asynchronous error, and late S after attempted F", () => {
  for (const lines of [
    ["F|-|12|-|0|-|-|nn|input|-", "E|-|12|-|0|-|-|nn|input|-"],
    [normal[0], "F|2|12|-|1|-|-|oo|spawn|-", "X|3|12|-|1|-|-|pp|spawn|-", "E|4|12|-|1|-|-|cc|spawn|-"],
    [normal[0], "F|2|12|-|1|-|-|oo|stopped|-", "S|3|12|13|1|-|-|pp|stopped|-", "X|4|12|13|1|-|15|cc|stopped|-", "E|5|12|13|1|-|15|cc|stopped|-"],
  ]) assert.equal(decode(lines).finished, true);
});

test("phase order, first cause, cleanup, PID, time, descriptors and result cannot regress", () => {
  const bad = [[], [normal[0]], [normal[1], normal[0]], [normal[0], normal[0]], [...normal, normal[3]],
    [normal[0], "S|0|12|13|1|-|-|oo|-|-"], [normal[0], "S|2|99|13|1|-|-|oo|-|-"],
    [normal[0], "F|2|12|-|0|-|-|pp|stopped|-", "S|3|12|13|1|-|-|cc|stopped|-"],
    [normal[0], normal[1], normal[2], "E|4|12|14|1|0|-|cc|-|-"],
    [normal[0], normal[1], normal[2], "E|4|12|13|1|0|-|oo|-|-"],
    [normal[0], "F|2|12|-|0|-|-|cc|stopped|close", "E|3|12|-|0|-|-|cc|clock|close"],
    [normal[0], "F|2|12|-|0|-|-|cc|stopped|close", "E|3|12|-|0|-|-|cc|stopped|-"],
    [normal[0], "X|2|12|-|1|-|-|cc|-|-", "E|3|12|-|1|-|-|cc|-|-"],
    ["F|1|12|-|0|-|-|nn|input|-", normal[0]],
  ];
  for (const lines of bad) assert.throws(() => decode(lines), { code: "LAUNCH_CONTROL" });
});

test("failed outcome and cleanup cannot be followed by an unrelated first cause", () => {
  const cases = [
    [normal[0], normal[1], "X|3|12|13|1|7|-|cc|-|-", "F|4|12|13|1|7|-|cc|stopped|-", "E|5|12|13|1|7|-|cc|stopped|-"],
    [normal[0], "S|2|12|13|1|-|-|oo|-|close", "F|3|12|13|1|-|-|cc|stopped|close", "X|4|12|13|1|0|-|cc|stopped|close", "E|5|12|13|1|0|-|cc|stopped|close"],
    [normal[0], normal[1], "F|3|12|13|1|7|-|cc|stopped|-", "X|4|12|13|1|7|-|cc|stopped|-", "E|5|12|13|1|7|-|cc|stopped|-"],
    [normal[0], normal[1], "X|3|12|13|1|-|-|cc|-|-", "F|4|12|13|1|-|-|cc|stopped|-", "E|5|12|13|1|-|-|cc|stopped|-"],
    [normal[0], normal[1], "F|3|12|13|1|0|-|cc|child|-", "X|4|12|13|1|0|-|cc|child|-", "E|5|12|13|1|0|-|cc|child|-"],
  ];
  for (const lines of cases) assert.throws(() => decode(lines), { code: "LAUNCH_CONTROL" });
  assert.equal(decode([normal[0], normal[1], "F|3|12|13|1|7|-|pp|child|-", "X|4|12|13|1|7|-|cc|child|-", "E|5|12|13|1|7|-|cc|child|-"]).finished, true);
  assert.equal(decode([normal[0], normal[1], "F|3|12|13|1|-|-|pp|stopped|-", "X|4|12|13|1|7|-|cc|stopped|-", "E|5|12|13|1|7|-|cc|stopped|-"]).finished, true);
});

test("closed ASCII grammar and ranges; EOF requires complete terminal record", () => {
  const bad = [wire(normal[0]).subarray(0, -1), Buffer.from(wire(normal[0]).toString().replace(/\n$/, "\r\n")),
    wire(normal[0].replace("|1|", "|01|")), wire(normal[0].replace("|12|", "|0|")),
    wire("X|2|12|13|1|0|15|cc|-|-"), wire("X|2|12|13|1|256|-|cc|-|-"),
    wire("X|2|12|13|1|-|65|cc|-|-"), wire("F|2|12|-|0|-|-|nn|SECRET|-"),
    Buffer.from([255, 10]), wire(normal[0]).subarray(1), Buffer.from("\n")];
  for (const bytes of bad) {
    const d = createLaunchControlDecoder(expected);
    assert.throws(() => { d.push(bytes); d.finish(); });
    assert.equal(d.snapshot().failed, true);
    assert.throws(() => d.push(wire(normal[0])));
  }
});

test("retention guards precede parse: 178/179 line, 890/891 total (conservative bounds)", () => {
  const d = createLaunchControlDecoder(expected);
  d.push(Buffer.alloc(178, 65));
  assert.equal(d.snapshot().peakRetainedBytes, 178);
  assert.throws(() => d.push(Buffer.from("A")), { code: "LAUNCH_CONTROL_LIMIT" });
  assert.equal(d.snapshot().retainedBytes, 178);
  const oversized = createLaunchControlDecoder(expected);
  assert.throws(() => oversized.push(Buffer.alloc(891, 65)), { code: "LAUNCH_CONTROL_LIMIT" });
  assert.equal(oversized.snapshot().totalBytes, 0);
  assert.equal(oversized.snapshot().peakRetainedBytes, 0);
  const withinTotal = createLaunchControlDecoder(expected);
  assert.throws(() => withinTotal.push(Buffer.alloc(890, 65)), { code: "LAUNCH_CONTROL_LIMIT" });
  assert.equal(withinTotal.snapshot().totalBytes, 890);
  assert.equal(withinTotal.snapshot().peakRetainedBytes, 178);
  // Neither bound is asserted to be a reachable valid sequence length.
});

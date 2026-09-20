import assert from "node:assert/strict";
import { test } from "node:test";
import { formExecutableProgram } from "../../dist/program-formation.js";

function input(length = 1) {
  return {
    shape: [length], dtype: "float32", device: "cpu", layout: "contiguous",
    producer: null,
    provenance: { operation: "tensor", source: "RuntimeSession.tensor" },
  };
}

function add(left, right) {
  const provenance = { operation: "add", source: "Tensor.add" };
  return {
    ...input(left.shape[0]), provenance,
    producer: { definition: { loweredKind: "add-f32" }, inputs: [left, right], provenance },
  };
}

function slots(program) {
  return program.computations.map(({ left, right, output }) => [left, right, output]);
}

test("formation preserves branch order, repeated inputs and shared ancestry once", () => {
  const left = input();
  const right = input();
  const shared = add(right, left);
  const firstBranch = add(shared, left);
  const secondBranch = add(shared, shared);
  const root = add(firstBranch, secondBranch);
  const unrelated = add(input(), input());
  const leftData = new Float32Array([2]);
  const rightData = new Float32Array([3]);
  const entries = new Map([
    [left, { kind: "host", data: leftData }],
    [right, { kind: "host", data: rightData }],
    [unrelated, { kind: "host", data: new Float32Array([9]) }],
  ]);
  const reads = [];
  const formed = formExecutableProgram(root, {
    get(value) { reads.push(value); return entries.get(value); },
  });
  assert.deepEqual([...formed.valuesBySlot.values()], [right, left, shared, firstBranch, secondBranch, root]);
  assert.deepEqual(slots(formed.program), [[0, 1, 2], [2, 1, 3], [2, 2, 4], [3, 4, 5]]);
  assert.deepEqual(formed.newlyComputed, [shared, firstBranch, secondBranch, root]);
  assert.equal(reads.length, 6);
  assert.equal(new Set(reads).size, 6);
  assert.ok(!reads.includes(unrelated));
  assert.equal(formed.bindings.size, 2);
  assert.equal(formed.bindings.get(0).hostData, rightData);
  assert.equal(formed.bindings.get(1).hostData, leftData);
  assert.equal(formed.program.result, 5);
  assert.equal(root.producer.inputs[0], firstBranch);
  assert.equal(entries.size, 3);
});

test("resident values cut traversal even when producer ancestry remains attached", () => {
  const ancestor = input();
  const resident = add(ancestor, ancestor);
  const root = add(resident, resident);
  const allocation = Object.freeze({ opaqueTestAllocation: true });
  const reads = [];
  const formed = formExecutableProgram(root, {
    get(value) {
      reads.push(value);
      assert.notEqual(value, ancestor);
      return value === resident ? { kind: "resident", allocation } : undefined;
    },
  });
  assert.deepEqual(reads, [root, resident]);
  assert.deepEqual(slots(formed.program), [[0, 0, 1]]);
  assert.deepEqual(formed.newlyComputed, [root]);
  assert.equal(formed.bindings.get(0).resident, allocation);
  assert.equal(formed.program.values[0].source, "binding");
  assert.deepEqual(formed.program.values[0].provenance, resident.provenance);
  const boundRoot = formExecutableProgram(resident, new Map([[resident, { kind: "resident", allocation }]]));
  assert.equal(boundRoot.program.values.length, 1);
  assert.deepEqual(boundRoot.program.computations, []);
  assert.deepEqual(boundRoot.newlyComputed, []);
  assert.equal(boundRoot.program.result, 0);
});

test("formation snapshots immutable structure but leaves payloads and occurrences in bindings", () => {
  const source = input(0);
  const root = add(source, source);
  const data = new Float32Array(0);
  const formed = formExecutableProgram(root, new Map([[source, { kind: "host", data }]]));
  source.shape[0] = 7;
  root.provenance.source = "changed after formation";
  assert.deepEqual(formed.program.values[0].shape, [0]);
  assert.equal(formed.program.computations[0].provenance.source, "Tensor.add");
  assert.equal(formed.bindings.get(0).hostData, data);
  assert.equal(formed.valuesBySlot.get(1), root);
  assert.ok(Object.isFrozen(formed.program));
  for (const value of formed.program.values) {
    assert.ok(Object.isFrozen(value));
    assert.ok(Object.isFrozen(value.shape));
    assert.ok(Object.isFrozen(value.provenance));
    assert.deepEqual(Object.keys(value).sort(), ["device", "dtype", "layout", "provenance", "shape", "slot", "source"]);
  }
  assert.ok(Object.isFrozen(formed.program.computations[0]));
  assert.ok(Object.isFrozen(formed.program.computations[0].provenance));
  assert.deepEqual(slots(formed.program), [[0, 0, 1]]);
});

test("host-only formation produces a binding without computations", () => {
  const root = input();
  const data = new Float32Array([4]);
  const formed = formExecutableProgram(root, new Map([[root, { kind: "host", data }]]));
  assert.equal(formed.program.values.length, 1);
  assert.equal(formed.program.result, 0);
  assert.deepEqual(formed.program.computations, []);
  assert.deepEqual(formed.newlyComputed, []);
  assert.equal(formed.bindings.get(0).hostData, data);
});

for (const topology of ["chain", "shared"]) {
  test(`deep ${topology} formation visits only the selected graph in linear work`, () => {
    const depth = 8192;
    const source = input();
    const other = input();
    let root = source;
    for (let index = 0; index < depth; index += 1) {
      root = add(root, topology === "chain" ? other : root);
    }
    let reads = 0;
    const formed = formExecutableProgram(root, {
      get(value) {
        reads += 1;
        return value.producer === null ? { kind: "host", data: new Float32Array([1]) } : undefined;
      },
    });
    const inputCount = topology === "chain" ? 2 : 1;
    assert.equal(reads, depth + inputCount);
    assert.equal(formed.valuesBySlot.size, depth + inputCount);
    assert.equal(formed.program.values.length, depth + inputCount);
    assert.equal(formed.program.computations.length, depth);
    assert.equal(formed.newlyComputed.length, depth);
    for (const computation of formed.program.computations) {
      assert.ok(computation.left < computation.output);
      assert.ok(computation.right < computation.output);
      if (topology === "shared") assert.equal(computation.left, computation.right);
    }
  });
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { planLinearDispatch } from "../../../dist/backends/webgpu/linear-dispatch.js";
import { gpuTensorCapacityBytes, validateSharedGpuPayloadBytes } from "../../../dist/backends/webgpu/webgpu-capacity.js";

const invocation = { kind: "invocation", workgroupSize: 64, elementsPerInvocation: 1 };
const cooperative = { kind: "workgroup", workgroupSize: 64, elementsPerWorkgroup: 128 };

for (const space of [invocation, { ...invocation, elementsPerInvocation: 4 }, cooperative]) {
  test(`linear dispatch covers each logical group once with bounded uniform padding (${space.kind}/${space.elementsPerInvocation ?? space.elementsPerWorkgroup})`, () => {
    const span = space.kind === "invocation" ? space.workgroupSize * space.elementsPerInvocation : space.elementsPerWorkgroup;
    for (const axis of [1, 3, 7, 65535]) for (const count of [0, 1, span - 1, span, span + 1, 7 * span + 1, 31 * span + 3]) {
      const groups = Math.ceil(count / span);
      if (groups > axis * axis) {
        assert.throws(() => planLinearDispatch(count, space, axis), { code: "RESOURCE_EXHAUSTED" });
        continue;
      }
      const plan = planLinearDispatch(count, space, axis);
      assert.equal(plan.workgroups, groups);
      assert.equal(plan.z, 1);
      assert.ok(plan.x <= axis && plan.y <= axis);
      assert.equal(plan.layout, groups <= axis ? "linear" : "grid");
      const visits = new Uint8Array(groups);
      let padding = 0;
      for (let y = 0; y < plan.y; y++) for (let x = 0; x < plan.x; x++) {
        const group = x + y * plan.x;
        if (group < groups) visits[group]++; else padding++;
      }
      assert.ok(visits.every(count => count === 1));
      assert.equal(padding, plan.paddedWorkgroups - groups);
      assert.ok(plan.paddedWorkgroups * span <= 0x1_0000_0000);
    }
  });
}

test("dispatch validates logical, padded and representation bounds without allocating payload", () => {
  for (const count of [-1, .5, NaN, Infinity, 0x1_0000_0000]) {
    assert.throws(() => planLinearDispatch(count, invocation, 65535), { code: "RESOURCE_EXHAUSTED" });
  }
  for (const axis of [0, -1, .5, NaN]) assert.throws(() => planLinearDispatch(1, invocation, axis), { code: "RESOURCE_EXHAUSTED" });
  assert.throws(() => planLinearDispatch(0xffff_ffff, invocation, 65535), { code: "RESOURCE_EXHAUSTED" });
  assert.throws(() => planLinearDispatch(1, { ...invocation, elementsPerInvocation: 0 }, 7), { code: "RESOURCE_EXHAUSTED" });
  const plan = planLinearDispatch(5_000_067, invocation, 65535);
  assert.deepEqual([plan.x, plan.y, plan.z], [39064, 2, 1]);
});

test("storage and signed completion capacity do not inherit an axis window", () => {
  const limits = { maxBufferSize: 2 ** 34, maxStorageBufferBindingSize: 2 ** 34, maxComputeWorkgroupsPerDimension: 1 };
  assert.equal(gpuTensorCapacityBytes(limits), 2147483644);
  assert.equal(gpuTensorCapacityBytes({ ...limits, maxBufferSize: 259 }), 256);
  assert.equal(gpuTensorCapacityBytes({ ...limits, maxStorageBufferBindingSize: 131 }), 128);
  assert.equal(validateSharedGpuPayloadBytes(2147483647), 2147483647);
  for (const bytes of [-1, .5, NaN, Infinity, 2147483648]) {
    assert.throws(() => validateSharedGpuPayloadBytes(bytes), { code: "RESOURCE_EXHAUSTED" });
  }
});

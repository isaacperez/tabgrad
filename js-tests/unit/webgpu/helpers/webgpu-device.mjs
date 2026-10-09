import assert from "node:assert/strict";

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

/** Acquisition-only double: numerical qualification uses a real browser/device. */
export function device() {
  const loss = deferred();
  return {
    destroyed: 0,
    lost: loss.promise,
    lose: () => loss.resolve({ reason: "unknown", message: "injected device loss" }),
    features: new Set(),
    adapterInfo: { vendor: "test", architecture: "test", description: "acquisition double", device: "", isFallbackAdapter: false },
    limits: { maxBufferSize: 268435456, maxStorageBufferBindingSize: 134217728,
      maxComputeWorkgroupsPerDimension: 65535, maxComputeWorkgroupSizeX: 256,
      maxComputeInvocationsPerWorkgroup: 256, maxStorageBuffersPerShaderStage: 8, maxComputeWorkgroupStorageSize: 16384 },
    destroy() { this.destroyed += 1; loss.resolve({ reason: "destroyed", message: "" }); },
  };
}

/** Controls completion/error events only; this double does not execute shaders. */
export function executionDevice({ completion = () => Promise.resolve(), finishError, mapError,
  mapping = () => Promise.resolve(), scopeError = () => null, bindGroupError } = {}) {
  const acquired = device();
  const buffers = [];
  const shaderSources = [];
  const dispatches = [];
  const bindingGroups = [];
  let scopes = 0;
  let submitted = 0;
  return Object.assign(acquired, {
    buffers,
    shaderSources, dispatches, bindingGroups,
    createShaderModule({ code }) { shaderSources.push(code); return {}; },
    async createComputePipelineAsync() { return { getBindGroupLayout() { return {}; } }; },
    createBindGroup({ entries }) {
      if (bindGroupError !== undefined) throw bindGroupError;
      bindingGroups.push(entries); return {};
    },
    pushErrorScope() { scopes += 1; },
    popErrorScope() { scopes -= 1; return Promise.resolve(scopes === 0 ? scopeError(submitted) : null); },
    createBuffer({ size }) {
      const buffer = {
        data: new ArrayBuffer(size), destroyed: false,
        destroy() { this.destroyed = true; },
        mapAsync() { return mapError === undefined ? mapping() : Promise.reject(mapError); },
        getMappedRange() { assert.equal(this.destroyed, false); return this.data; }, unmap() {},
      };
      buffers.push(buffer); return buffer;
    },
    createCommandEncoder() {
      const copies = [];
      return {
        beginComputePass() { return { setPipeline() {}, setBindGroup() {},
          dispatchWorkgroups(count) { dispatches.push(count); }, end() {} }; },
        copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, bytes) {
          copies.push(() => new Uint8Array(destination.data, destinationOffset, bytes).set(new Uint8Array(source.data, sourceOffset, bytes)));
        },
        finish() { if (finishError !== undefined) throw finishError; return copies; },
      };
    },
    queue: {
      writeBuffer(buffer, offset, data) { new Uint8Array(buffer.data, offset, data.byteLength).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); },
      submit(commands) { submitted += 1; for (const command of commands) for (const copy of command) copy(); },
      onSubmittedWorkDone() { return completion(submitted); },
    },
  });
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { broadcastGeometry, receivingGeometry } from "../../../dist/execution/broadcast-geometry.js";
import { pointwisePacket, receivingPacket } from "../../../dist/backends/cpu/broadcast-packet.js";
import { pointwiseDerivative } from "../../../dist/runtime/autograd/pointwise-derivative.js";

function extensionSource() {
  const source = fileURLToPath(new URL("../../../crates/tabgrad-wasm-kernels/src/", import.meta.url));
  return `
#[path = ${JSON.stringify(join(source, "abi.rs"))}] mod abi;
#[path = ${JSON.stringify(join(source, "pointwise.rs"))}] mod pointwise;
struct ProductPlus;
impl pointwise::Pointwise<3> for ProductPlus {
    fn scalar([a, b, c]: [f32; 3]) -> f32 { a * b + c }
    #[cfg(target_feature = "simd128")]
    fn vector([a, b, c]: [core::arch::wasm32::v128; 3]) -> core::arch::wasm32::v128 {
        use core::arch::wasm32::{f32x4_add, f32x4_mul};
        f32x4_add(f32x4_mul(a, b), c)
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn test_product_plus(a: u32, b: u32, c: u32, out: u32, packet: u32, words: u32) -> u32 {
    unsafe { pointwise::broadcast::<ProductPlus, 3>([a, b, c], out, packet, words) }
}`;
}

// This compiles a test-only arithmetic definition against the unchanged production
// traversal. It creates no public operation, backend registration or Wasm asset.
for (const variant of ["scalar", "simd128"]) test(`third-arity channel policy executes shared traversal and receiving (${variant})`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tabgrad-broadcast-extension-"));
  try {
    const source = join(directory, "extension.rs"), binary = join(directory, "extension.wasm");
    await writeFile(source, extensionSource());
    execFileSync(process.env.RUSTC ?? "rustc", [source, "--edition=2024", "--crate-type=cdylib",
      "--target=wasm32-unknown-unknown", "-O", "-C", "link-arg=--import-memory", "-C", "link-arg=--initial-memory=2097152",
      "-C", "link-arg=--max-memory=67108864", "-C", `target-feature=${variant === "scalar" ? "-" : "+"}simd128`, "-o", binary], { stdio: "pipe" });
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 1024 });
    const extension = (await WebAssembly.instantiate(await readFile(binary), { env: { memory } })).instance.exports;
    const production = (await WebAssembly.instantiate(await readFile(new URL(`../../../dist/wasm/kernels-${variant}.wasm`, import.meta.url)), { env: { memory } })).instance.exports;
    let cursor = Math.max(extension.tabgrad_arena_base(), production.tabgrad_arena_base());
    function store(values, Words = Float32Array) {
      const offset = cursor; cursor += values.length * 4 + 16;
      assert.ok(cursor < memory.buffer.byteLength);
      new Words(memory.buffer, offset, values.length).set(values);
      return offset;
    }
    function calculate(inputs, geometry) {
      const offsets = inputs.map(value => store(value)), output = store(new Float32Array(geometry.elements));
      const words = pointwisePacket(geometry, memory.buffer.byteLength), packet = store(words, Uint32Array);
      assert.equal(extension.test_product_plus(...offsets, output, packet, words.length), 0);
      return new Float32Array(memory.buffer, output, geometry.elements).slice();
    }
    const geometry = broadcastGeometry(3, [{ shape: [2, 3, 4], axes: [0, 1, 2] }, { shape: [3], axes: [1] }, { shape: [], axes: [] }]);
    const a = Float32Array.from({ length: 24 }, (_, i) => i + 1), b = new Float32Array([2, 3, 4]);
    const result = calculate([a, b, [5]], geometry);
    assert.deepEqual([...result], [...a].map((value, i) => value * b[Math.floor(i / 4) % 3] + 5));
    const seed = { shape: geometry.shape, data: new Float32Array(24).fill(0.5) }, closed = [];
    const operations = {
      shape: value => value.shape,
      close: value => { assert.notEqual(value, seed); closed.push(value); },
      receive(value, projection) {
        const input = store(value.data), output = store(new Float32Array(projection.groups));
        const words = receivingPacket(projection, memory.buffer.byteLength), packet = store(words, Uint32Array);
        assert.equal(production.tabgrad_receive_f32(input, output, packet, words.length), 0);
        return { shape: projection.originalShape, data: new Float32Array(memory.buffer, output, projection.groups).slice() };
      },
    };
    const local = { savedOperands: position => position === 2 ? [] : [1 - position],
      apply(incoming, _saved, shape, _operations, position) {
        const factor = position === 0 ? Float32Array.from(a, (_, i) => b[Math.floor(i / 4) % 3]) : position === 1 ? a : new Float32Array(24).fill(1);
        // Local arithmetic uses the same real ternary traversal with c=0.
        return { shape, data: calculate([incoming.data, factor, [0]], broadcastGeometry(3, [
          { shape, axes: [0, 1, 2] }, { shape, axes: [0, 1, 2] }, { shape: [], axes: [] },
        ])) };
      },
    };
    const recipe = pointwiseDerivative(local, geometry);
    const gradients = geometry.operands.map((operand, position) => recipe.apply(seed, [], operand.shape, operations, position));
    assert.deepEqual(gradients.map(value => [...value.data]), [
      [...a].map((_, i) => b[Math.floor(i / 4) % 3] * 0.5), [34, 50, 66], [12],
    ]);
    assert.deepEqual(gradients.map(value => value.shape), [[2, 3, 4], [3], []]);
    assert.equal(closed.length, 2, "only contributions replaced by reductions retire inside the adapter");
    assert.equal(receivingGeometry(geometry, 1).terms, 8);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

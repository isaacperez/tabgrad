# JavaScript tensor API

This document is the user reference for calling the Tabgrad tensor runtime
directly from JavaScript. It describes a deliberately narrow but complete
execution path: one-dimensional contiguous `float32` tensors on the CPU and
out-of-place elementwise addition. A narrow contract is useful here because it
lets a reader see the complete lifecycle—admission, lazy recording, WebAssembly
execution, observation, and release—without implying support for tensor
features that have not been established by tests.

Python does not sit between this API and the runtime. Any Python compatibility
layer uses the same TypeScript semantic runtime as this JavaScript interface;
Tabgrad does not define a separate numerical engine for each frontend.

## Browser delivery requires no developer toolchain

A web application serves the files emitted under `dist/` by the Tabgrad build.
The application imports `index.js`; Tabgrad resolves `manifest.json` beside that
module and loads one compatible WebAssembly module when CPU data is first
observed. Browser users do not install Node.js, npm, Rust, Cargo, TypeScript, a
native tensor library, or a browser extension.

The web server must serve `.wasm` files as `application/wasm` and preserve the
relative, same-origin artifact paths in the generated manifest. The runtime
uses Web Cryptography to verify each selected module's SHA-256 digest, so the
page must run in a secure context or a browser-trusted local context such as
loopback HTTP. Cross-origin hosting of the manifest itself also needs ordinary
Cross-Origin Resource Sharing permission. A content-security policy must permit
WebAssembly compilation. The development toolchain and build command are
documented in [Development environment and commands](development.md).

## Create, compute, observe, and release

The public module exports `createRuntimeSession`, `RuntimeSession`, `Tensor`,
and `TabgradError`. A session owns one WebAssembly CPU context and its linear
memory. A tensor handle belongs to exactly one session.

Those exported classes expose only the methods described in this reference.
Backend dispatch, semantic-state access, and test instrumentation are kept in
module-private closures or non-public test entry points; an `@internal` type
annotation alone is not treated as JavaScript runtime encapsulation.
`Tensor` is exported so applications can use the class identity, but only a
runtime session can construct a valid tensor handle; calling `new Tensor()` from
JavaScript fails with `INVALID_TENSOR`.

```javascript
import { createRuntimeSession } from "./tabgrad/index.js";

const session = createRuntimeSession();
const left = session.tensor([1, 2, 3]);
const right = session.tensor([4, 5, 6]);
const sum = left.add(right);

console.log(sum.shape); // [3]
console.log(Array.from(await sum.toArray())); // [5, 7, 9]

left.close();
right.close();
sum.close();
await session.close();
```

`session.tensor(data, options?)` copies an iterable or array-like collection
into a host `Float32Array`. Its default and supported metadata are:

| Property | Supported value |
| --- | --- |
| Shape | One dimension whose length equals the input collection length |
| Data type | `float32` |
| Device | `cpu` |
| Layout | `contiguous` |

When supplied from JavaScript, `options.shape` must be an actual array with one
non-negative safe-integer element equal to the copied data length. `null`, a
number, an array-like object, a different rank, or a different length is an
`INVALID_SHAPE` error. This runtime check is required even though TypeScript
callers also receive a static `readonly number[]` type.

`left.add(right)` validates both operands synchronously and returns a new
tensor handle. It does not fetch, compile, instantiate, or call WebAssembly.
The operands must be open, belong to the same session, and have equal shapes.
The runtime checks handle identity in its module-private registry: inheriting
from `Tensor.prototype` or wrapping a tensor in a JavaScript `Proxy` does not
forge a valid handle. Invalid handles fail with `INVALID_TENSOR` before backend
loading. The result is out of place: it has independent logical storage.

`tensor.toArray()` is the asynchronous observation boundary. The runtime forms
an immutable finite executable program for the demanded dependencies, chooses
one WebAssembly module, copies host inputs into its linear memory, invokes the
coarse addition kernel, and returns a new `Float32Array`. Intermediate results
remain resident in WebAssembly memory; observing one result does not execute an
unrelated pure operation.

The executable program contains JavaScript metadata collections because the
backend needs an ordered list of logical values and computations. It never
contains tensor payloads in JavaScript arrays, backend memory offsets, pointers,
or WebAssembly objects. The numerical data stays in the materialization table
until CPU preparation binds it to WebAssembly allocations. This distinction
keeps the program immutable and backend-facing without turning it into a second
numerical storage system.

An executable program belongs to the observation request that formed it. A
resident materialization stores only its physical allocation, not the complete
program that happened to produce or reuse it. Observing an already resident
tensor forms a fresh one-value request program for readback. Consequently, a
small live tensor cannot retain an arbitrarily large completed downstream graph
or inherit that graph's diagnostic identity.

`tensor.close()` releases the public handle and is idempotent. A pending result
keeps the exact input values it needs alive even if their handles close first.
`session.close()` rejects new work, drains observations already accepted by the
session, releases resident allocations, and is also idempotent. Applications
should close long-lived tensors and sessions explicitly rather than depending
on JavaScript garbage-collection timing.

## Select a manifest location

By default, `createRuntimeSession()` resolves `manifest.json` relative to the
imported Tabgrad module. An application that hosts assets elsewhere can provide
an absolute or module-relative URL:

```javascript
const session = createRuntimeSession({
  manifestUrl: new URL("./assets/tabgrad/manifest.json", import.meta.url),
});
```

Module-variant forcing belongs only to Tabgrad's internal test entry point. The
ordinary API detects WebAssembly SIMD support and selects either `simd128` or
the scalar module. Variant selection changes the physical kernel, not tensor
meaning, and an incompatible or corrupt artifact fails rather than falling
back to JavaScript arithmetic.

## Errors are part of admission and execution

`TabgradError` has a stable `code`, a human-readable `message`, and immutable
`details`. Errors that can be determined from tensor metadata are thrown by
`tensor()` or `add()` before any backend submission. Loading, ABI, memory, and
kernel errors reject the promise returned by `toArray()`.

An asynchronous backend error records the `webassembly-cpu` backend and its
specific failure phase in `details`. It also retains, as internal diagnostic
context, the demanded immutable executable program, its declared domain, the
causal operation and stable source provenance, and the applicable backend
endpoint. When execution reaches a kernel, the context also identifies the
causal output slot in that program, so a failure in an earlier computation of a
chain is not misattributed to the demanded root. That program is not added to
the public tensor API. When the browser or WebAssembly engine supplies a native
error, `cause` preserves it. Repeated observations of one cached preparation
failure receive distinct error objects and therefore cannot acquire another
invocation's program or provenance.

| Code | Meaning |
| --- | --- |
| `CLOSED_SESSION`, `CLOSED_TENSOR` | An operation used an explicitly closed lifetime. |
| `DIFFERENT_SESSION`, `INVALID_TENSOR` | Addition mixed sessions or received something other than a Tabgrad tensor handle. |
| `INVALID_DATA`, `INVALID_SHAPE` | Input data or its one-dimensional shape is invalid. |
| `SHAPE_MISMATCH` | Addition operands have unequal lengths. |
| `UNSUPPORTED_DTYPE`, `UNSUPPORTED_DEVICE`, `UNSUPPORTED_LAYOUT` | Metadata is outside the table above. |
| `BACKEND_MANIFEST_INVALID`, `BACKEND_HASH_MISMATCH` | Distributed metadata or bytes fail validation. |
| `BACKEND_ABI_MISMATCH`, `BACKEND_CAPABILITY_MISMATCH` | A module cannot satisfy the declared CPU contract. |
| `BACKEND_LOAD_FAILED` | Fetch, parsing, compilation, or instantiation cannot initialize the context. |
| `BACKEND_STATUS_ERROR`, `BACKEND_TRAP` | A kernel rejects its call or traps; a trapped context is quarantined. |
| `RESOURCE_EXHAUSTED` | A request cannot fit the bounded 32-bit WebAssembly memory. |

Unsupported behavior is never silently moved to WebGPU or evaluated with a
JavaScript numerical loop.

## Diagnostics and cost model

`session.diagnostics()` returns a snapshot intended for inspection and
performance evidence. It reports module-load count, selected module variant,
kernel-call count, host-to-WebAssembly and WebAssembly-to-host byte and copy
counts, live and high-water tensor payload and aligned allocation bytes, total
WebAssembly memory, and separated manifest-fetch, module-fetch, integrity,
compilation, and instantiation durations. It also reports the current number
of public tensor handles, semantic tensor values, recorded operations,
materialization records, and accepted observation requests. These semantic
counters make it possible to distinguish a retained computation from
WebAssembly memory growth and to prove that explicit shutdown drains both
layers. Reading diagnostics does not demand a tensor.

For an addition of two distinct length-`n` host inputs, the first observation
uses one `4n`-byte import for each input, one `4n`-byte output allocation, one
kernel call independent of `n`, and one `4n`-byte result readback. This appears
as two host-to-WebAssembly copies and one WebAssembly-to-host copy. A later
observation of the same resident value performs another readback but no new
input upload or kernel call. Alignment and module-private memory are bounded
separately. Reusing resident inputs does not copy them from JavaScript again,
and released allocation ranges return to the session pool.

The JavaScript unit suite checks admission, lazy loading, scalar and SIMD
modules, finite chains, the raw ABI, structured failures, copy and call counts,
and allocation reuse. The browser integration suite runs the scalar and SIMD
paths in both Chrome and Firefox. Exact commands and environment requirements
are in [Development environment and commands](development.md); release-level
browser and PyTorch claims remain governed by the
[compatibility record](compatibility.md).

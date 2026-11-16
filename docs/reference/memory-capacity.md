# CPU memory and update capacity

CPU numerical memory, logical update reservations and host memory are separate
resource domains. A larger numerical arena does not increase the allowance for
gradients, retained values or persistent updates.

## Configure a session

`RuntimeSessionOptions.memoryLimits` accepts these optional settings:

| Setting | Default | Accepted values | Meaning |
| --- | ---: | --- | --- |
| `cpuLinearMemoryBytes` | 64 MiB | Safe integer byte counts from 2 MiB to 256 MiB, divisible by 65,536 | Maximum total CPU linear memory for this session, including the module's private region and numerical arena. |
| `updateBackingBytes` | 64 MiB | Nonnegative safe integer byte counts at most 64 MiB | Logical backing allowance used by update and differentiation admission. |

One MiB is 1,048,576 bytes. Omitted settings retain their defaults; `null`,
incorrect types, unknown own fields and out-of-range values throw `TypeError`.
Options are copied into immutable numeric configuration before asynchronous
factory or attachment work. Later changes to the caller's object cannot change
an accepted session. Sessions do not share a budget or silently resize one
another.

```javascript
import { createRuntimeSession } from "./tabgrad/index.js";

const session = createRuntimeSession({
  memoryLimits: { cpuLinearMemoryBytes: 128 * 1024 * 1024 },
});
try {
  // Create and observe tensors through this session.
  console.log(session.diagnostics().memoryLimits);
} finally {
  await session.close();
}
```

`createWebGpuRuntimeSession()` accepts the same settings for its CPU context
and shared update admission; they do not configure GPU buffer limits.
`attachPython(interpreter, { memoryLimits })` applies the same contract to a
local attachment's owned runtime, including an attachment with a managed GPU
connection. Its `manifestUrl` still selects Python source assets, not the CPU
manifest. A remote script connection does not gain a reconfiguration or
diagnostics request API: the application configures the binding where it owns
the interpreter.

## Artifact ceiling and actual allocation

The matched CPU artifact profile has module version 8, raw ABI version 1,
32-bit non-shared memory, an initial size of 32 pages and an import ceiling of
4,096 pages. Scalar and SIMD modules share this memory contract. The loader
creates the imported memory with the resolved **session** maximum, which may
be smaller than the artifact ceiling, and the allocator and packet bounds use
that same session maximum.

A new context initially has 2 MiB of linear memory. Choosing a maximum of
128 MiB or 256 MiB does not allocate that amount immediately. Memory grows only
when required by allocations, and the host may still reject growth within the
configured ceiling. The complete matching distribution must be used; the
profile does not promise compatibility with an older or mixed manifest/module.

The numerical arena starts at the artifact's exported arena boundary. Its
maximum span is the session limit minus that boundary, not the entire linear
memory limit. Inputs, distinct outputs, aligned ranges and workspaces may need
to coexist. Reusable free ranges do not guarantee that any requested contiguous
allocation fits, and released linear memory need not shrink.

## Logical reservation remains independent

`updateBackingBytes` changes only the existing logical admission budget; the
owner and pending-effect limits remain unchanged. Admission still accounts for
topology, repeated edges, saved values, prior gradients and effects before
consuming history or publishing updates. Numerical buffer reuse cannot be
substituted for those logical obligations.

The proven no-control/no-effect functional-gradient reservation omission
remains valid. A zero allowance therefore does not ban tensor creation or all
differentiation. Nor is this allowance a universal cap on host tensor data:
host-only creation and observation can copy data before CPU preparation.

Neither setting bounds JavaScript arrays, Pyodide, transfer/readback copies,
total RAM, total GPU memory or process RSS. Applications must budget those
domains separately. A larger CPU ceiling is not a promise that a complete
training graph fits.

## Inspect capacities without executing work

`session.diagnostics().memoryLimits` is a frozen snapshot of the effective
`cpuLinearMemoryBytes` and `updateBackingBytes`, available before preparation
and after close. `cpuMemoryCapacity` is `null` before successful CPU preparation,
after failed preparation, or after the CPU context is closed. Once prepared it
is a frozen record:

| Field | Meaning |
| --- | --- |
| `artifactMaximumBytes` | Validated artifact import ceiling. |
| `linearMemoryLimitBytes` | Actual maximum selected for this context. |
| `arenaBaseBytes` | First byte available to numerical allocations. |
| `arenaCapacityBytes` | Maximum arena span, excluding the private prefix. |

These are capacities, not estimates of currently free contiguous storage or
backend health. Existing `wasmMemoryBytes`, live/reserved allocation counters
and high-water counters retain their own meanings. Reading diagnostics does
not prepare CPU or demand numerical values; retain a pre-close sample when
inspecting retired physical resources. Numeric snapshots do not retain tensor,
session or memory objects. Local Python diagnostics expose the same fields.

## Failure boundaries

Configured numerical exhaustion remains `RESOURCE_EXHAUSTED` with
`details.capacityDomain = "cpu-linear-memory"`, `phase = "allocation"` and
the required/maximum byte and page counts. A host growth rejection uses the
same domain with `phase = "memory-growth"` and retains the original cause.
Rejected growth does not commit the allocator cursor or counters; invocation
rollback preserves borrowed inputs and permits a fitting later request.

Logical rejection uses the `update-backing` or `update-owners` capacity domain
and `phase = "admission"`, with the existing owner/backing demand fields.
Other pending-effect or version limits retain their own errors. A capacity
failure is not a numerical kernel trap and does not trigger device fallback.
Artifact validation, instantiation errors and trap quarantine retain their
existing ownership and phases.

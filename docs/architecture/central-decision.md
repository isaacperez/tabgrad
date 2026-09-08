# Central browser execution architecture decision

**Decision:** accepted on 2026-09-07 under
[research issue #11](https://github.com/isaacperez/tabgrad/issues/11).

**CPU backend refinement:** accepted on 2026-09-08 under
[research issue #31](https://github.com/isaacperez/tabgrad/issues/31).

This record explains why Tabgrad uses one effect-aware, incrementally lazy
TypeScript semantic runtime with bounded demand regions and two private numerical
backends. The other architecture chapters define the resulting contracts in
detail. This record preserves the alternatives, evidence limits, consequences,
and conditions for reconsideration.

## Context

Tabgrad needs PyTorch-like dynamic program behavior, views, aliases, mutation,
automatic differentiation, repeated training, explicit devices, and broad
operation growth. It also needs browser-efficient fusion, storage residency,
dispatch, compilation reuse, and bounded memory on WebGPU and WebAssembly.

A design optimized only for immediate API simplicity risks duplicating operation
and backend rules and losing cross-operation optimization. A design optimized
only for static inference risks changing error timing, mutation, dynamic control
flow, and derivative lifetimes. Reusing an existing inference engine would add a
second semantic authority without supplying the required eager-compatible
training behavior.

The decision therefore had to preserve correctness and explicit failure first,
browser robustness second, measured inference and training performance third,
maintainability and reversibility fourth, and initial implementation speed fifth.

## Decision

Tabgrad adopts these connected constraints:

1. Python and JavaScript frontends use one runtime client contract and normally
   exchange handles and small metadata rather than tensor payloads.
2. One `RuntimeSession` scopes semantic identity, effects, derivatives, errors,
   budgets, backend references, and lifecycle.
3. Public operations are validated immediately and enter a reclaimable
   incremental semantic graph formed from the state records in
   [Semantic state](semantic-state.md).
4. Pure numerical payloads are deferred by default. Named observations and
   mandatory effects select finite closures under
   [bounded lazy execution](bounded-lazy-execution.md).
5. Every selected closure, including a one-operation closure, becomes one
   immutable `ExecutableProgram` using the common schema. Its discriminated
   execution domain is either one compute-backend target profile or one explicit
   source-to-destination transfer route.
6. Common passes own semantic legality and logical dependencies. Each backend
   privately owns profitable physical lowering, scheduling, preparation,
   kernels, memory, dispatch, and completion for its compute domain. The runtime
   coordinates both opaque endpoint operations and their shared staging
   lifecycle for a transfer domain.
7. WebGPU with WebGPU Shading Language and the WebAssembly CPU implementation
   are the only numerical backends. CPU kernels are authored in Rust, compiled
   into prebuilt scalar and fixed-vector WebAssembly modules, and called through
   a Tabgrad-owned raw binary interface over backend-owned linear memory.
   Selection and transfer are explicit, with no silent fallback. The complete
   CPU contract is defined in
   [WebAssembly CPU backend](webassembly-cpu-backend.md).
8. Forward computation, vector-Jacobian and Jacobian-vector products, gradient
   accumulation, and optimizer work use the same admission, program, request,
   ticket, and backend path.
9. An internal direct-program seam and optional bounded, fully guarded
   `CompiledCallable` can reuse stable work while each call receives fresh
   semantic state.
10. Semantic records, requests, histories, variants, programs, prepared work,
    diagnostics, and backend memory have explicit owners and bounded lifetimes.
11. Repeated mixed compositions use child-program fingerprints and boundary
    remaps to reuse a flat program. A hot hit does not reconstruct every
    computation inside an unchanged reusable child.

The guiding implementation rule is to introduce a named stateful component only
when it owns an independent identity, invariant, or lifecycle. Validation,
differentiation, demand selection, lowering, and common planning remain passes
over shared records unless evidence establishes a separate stateful owner.
`ProgramCallRecord` is a tagged `OperationRecord`; `ExecutionTicket` can be a
read-only view over the same allocation as invocation state; and
`MaterializationTable` can be an ordinary session-owned index. These names
preserve contracts without requiring a class or manager for every concept.

### Minimum implementation shape

The architecture names several concepts because their identities or lifetimes
must not be confused. A compact implementation has one `RuntimeSession` as the
common semantic aggregate and backend contexts as the physical owners. The
remaining concepts are data, indexes, passes, or views owned by those roots.

| Architectural concept | Minimum implementation role |
| --- | --- |
| `OperationDefinition` | Immutable operation schema shared by sessions |
| `TensorState`, `TensorValue`, `StorageState`, and `OperationRecord` | Compact records in session-owned tables |
| `ProgramCallRecord` | Tagged `OperationRecord` specialization, not a separate graph or store |
| `DerivativeHistory` | Live derivative records and use counts with an independent semantic lifetime |
| `MaterializationTable` | Session-owned index from logical versions to opaque backend references |
| Admission, demand selection, differentiation, and program formation | Ordinary passes over records unless later evidence requires state of their own |
| `ExecutableProgram` | Immutable common-schema data for one finite compute target or explicit transfer route |
| `PreparedExecutable` | Opaque backend-owned cached preparation for compute-domain work |
| `BackendCapabilitySnapshot` | Immutable semantic capabilities plus a separate token for one backend generation |
| `ExecutionRequest` and `ExecutionTicket` | One invocation's mutable state and a read-only completion view, including aggregate endpoint state for transfers; they need not be independent allocations |
| Transport and `CompiledCallable` adapters | Thin boundary mechanisms over the same runtime path |

This shape preserves the semantic distinctions that correctness requires
without constructing competing engines, planners, or managers.

## Alternatives considered

### Direct operation-at-a-time execution

This option maps simply to immediate public calls and remains a useful
experimental control. It does not expose arbitrary cross-operation fusion and
can make frontend, dispatch, and intermediate-memory overhead proportional to
every operation. Keeping it beside a lazy engine would duplicate semantics and
tests. The chosen design obtains its simple case through a one-operation demand
region on the common path.

### Persistent global or session graph

A long-lived graph offers broad optimization scope but makes dynamic control,
mutation order, error delivery, saved-value lifetime, and browser memory harder.
Bounded demand regions provide the required selected-closure and common-program
leverage without retaining a model graph for the life of a session. Repeated
program overhead is addressed more narrowly by direct guarded reuse.

### Universal public capture or compiled mode

Universal capture can avoid repeated frontend work, but it requires guards,
graph breaks, occurrence rebinding, effect and random-number rollback, derivative
attachment, variant memory, and complete fallback behavior. The direct program
seam plus optional `CompiledCallable` provides the justified reuse without making
capture the ordinary public model.

### Thin tensors, direct backend calls, and a small tape

This can be compact for a bounded CPU-only example. The responsibilities for
operation rules, aliasing, effects, errors, two backends, materialization,
automatic differentiation, memory, and fusion do not disappear. Leaving them
distributed would make broad operation and training support harder to keep
consistent.

### Reuse an existing execution engine

ONNX Runtime Web demonstrates feasible browser WebAssembly and WebGPU execution,
provider preparation, and backend-resident inputs and outputs. Its mandatory
static inference graph and provider fallback do not supply Tabgrad's
eager-compatible mutation, dynamic automatic differentiation, and explicit
backend semantics. Existing runtimes remain research evidence; Tabgrad does not
embed one as its tensor engine.

## Evidence

The decision integrates:

- [PyTorch architecture research](https://github.com/isaacperez/tabgrad/issues/13);
- [tinygrad, tinygpt, and Greed research](https://github.com/isaacperez/tabgrad/issues/14);
- [browser runtimes, Pyodide, and WebGPU research](https://github.com/isaacperez/tabgrad/issues/12);
- bounded investigations of observation, admission, effects, errors, mutation,
  derivative lifetimes, executable-program shape, realization, transformer
  execution, and repeated programs;
- the [final architecture synthesis](https://github.com/isaacperez/tabgrad/issues/11#issuecomment-5565226615),
  identified by SHA-256
  `2060a8a83655e5fb937366a8705e1437d9bbe6ac03a7139cb6d855002bde4457`;
- the [independent final challenge](https://github.com/isaacperez/tabgrad/issues/11#issuecomment-5565227563);
- the [explicit approval record](https://github.com/isaacperez/tabgrad/issues/11#issuecomment-5565539190);
  and
- the [approved structural refinement](https://github.com/isaacperez/tabgrad/issues/11#issuecomment-5566038792)
  covering flat composition, program calls, capability identity, cache keys,
  and invocation views.

Experiments used bounded real WebAssembly and WebGPU work and separated
correctness, lifecycle, memory, host-policy cost, preparation, dispatch, and
observation where the question required it. The complete methods, raw evidence,
failed or superseded attempts, and environment limitations remain in their
individual issues and linked artifacts rather than in normative architecture
prose.

The reusable-training experiment established that mixed semantic selections can
be flattened correctly, but it did not prove the asymptotic cost of repeated
large mixed compositions. The accepted refinement therefore requires a bounded
flat-composition cache whose hot lookup uses existing child fingerprints and
boundary structure. An implementation may claim that hot path is efficient only
when representative measurements support the claim; the structural requirement
alone is not performance evidence.

| Gate | Evidence record |
| --- | --- |
| Asynchronous Python observation | [#19](https://github.com/isaacperez/tabgrad/issues/19) |
| Cost and placement of operation admission | [#20](https://github.com/isaacperez/tabgrad/issues/20) |
| Progress, effects, and error ownership | [#21](https://github.com/isaacperez/tabgrad/issues/21) |
| Views, mutation, and derivative lifetimes | [#22](https://github.com/isaacperez/tabgrad/issues/22) |
| Backend-ready executable-program contract | [#23](https://github.com/isaacperez/tabgrad/issues/23) |
| Realization policy | [#24](https://github.com/isaacperez/tabgrad/issues/24) |
| Bounded transformer inference and training | [#25](https://github.com/isaacperez/tabgrad/issues/25) |
| Repeated-program reuse | [#26](https://github.com/isaacperez/tabgrad/issues/26) |
| Reusable training with dynamic differentiation | [#27](https://github.com/isaacperez/tabgrad/issues/27) |
| WebAssembly CPU toolchain, binary interface, and memory ownership | [#31](https://github.com/isaacperez/tabgrad/issues/31) |

## Consequences

The chosen architecture has more semantic structure than a minimal tensor that
calls kernels directly. That structure has one purpose: it gives ownership and
optimization seams to requirements Tabgrad already has, rather than distributing
them as special cases.

It also rejects some apparent shortcuts:

- adding an operation cannot define separate Python, JavaScript, WebGPU, and
  WebAssembly meanings;
- adding a backend cannot create its own tensor or automatic-differentiation
  runtime;
- an optimization cannot hide a transfer, delay a knowable semantic error,
  discard an effect, or retain unbounded state;
- compiled training cannot become a separate engine; and
- an importer cannot become another operation registry or numerical backend.

The boundaries leave physical policy reversible. Backends can change kernels,
layouts, allocators, compilation, fusion, and schedules. Runtime passes can
change record layout or program transformations. Frontends can change transport
deployment. Those changes remain local while the documented ownership and
observable semantics stay intact.

## What this decision does not establish

Architecture feasibility is not release support or a universal performance
claim. The evidence did not establish every browser, model, parameter count,
data type, higher-order or retained derivative mode, attention derivative,
mixed-precision mode, long-context concurrency pattern, device-loss scenario,
or cancellation race. It also did not benchmark a production flat-composition
cache over large mixed forward-and-backward regions.

Those evidence limits constrain compatibility and optimization claims. An
unqualified mode must reject explicitly or use the complete ordinary semantic
path when that path is supported. Narrow experimental performance differences
do not make compiled execution automatically profitable for all WebGPU or
WebAssembly workloads.

## Independently decidable details

The central architecture deliberately leaves local choices to focused work when
they do not change the responsibility boundaries above. These choices include:

- exact public method names and synchronization defaults;
- compact physical packing for derivative-history entries;
- the exact backend-neutral primitive vocabulary and individual optimization
  passes;
- exact WebAssembly call descriptors, allocator and pool policies, kernel
  partitioning justified by measurement, and optional worker topology within
  the constraints of
  [the CPU backend decision](webassembly-cpu-backend.md);
- the WebGPU kernel library, code generation, and tuning strategy;
- numeric allocator and cache budgets;
- operation, data-type, browser, and model support matrices;
- checkpointing and mixed-precision policies;
- evidence-based automatic profitability policy for compiled whole steps;
- model-import, weight-format, and tokenizer dependencies; and
- profiling and debugging presentation.

These details can optimize or extend the system, but they cannot introduce a
second semantic engine, move ordinary tensor payloads through Python, hide
backend transfers, retain unbounded graphs or caches, or give forward and
backward unrelated execution paths.

## Conditions for reconsideration

Reconsider this central decision only when reproducible evidence shows that:

- bounded demand regions cannot preserve required PyTorch-observable semantics;
- linear program formation or semantic storage remains materially dominant even
  with direct guarded reuse;
- correct training requires a different semantic representation;
- common `ExecutableProgram` data prevents an important backend optimization;
- the single-owner worker and handle boundary is untenable on required browsers;
  or
- representative supported models cannot reach bounded steady memory under the
  ownership and reclamation rules.

Kernel tuning, adding an operation, selecting a local record layout, changing a
public method name, or enabling another guarded compiled variant is not by itself
a reason to reopen the central architecture.

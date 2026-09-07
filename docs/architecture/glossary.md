# Architecture glossary

This glossary is a reference for terms already introduced in the architecture
guide. Each detailed chapter explains why its terms exist; use this page when
you need a short reminder.

## A

**Admission**
: The synchronous semantic processing of one public operation: resolution,
  validation, metadata inference, effect ordering, and creation of logical
  records. See [Operation admission](operation-admission.md).

**Alias**
: A tensor identity or view that shares logical storage with another tensor, so
  a mutation through one can affect what the other observes.

**Automatic differentiation**
: Construction of derivative computation from the operations the host program
  actually executed. It emits ordinary runtime operations rather than executing
  numerical loops itself.

## B

**Backend**
: The owner of physical preparation and numerical execution for one target.
  Tabgrad has WebGPU and WebAssembly numerical backends.

**Backend capability snapshot**
: One immutable description for a backend generation containing truthful
  capability facts and a separate generation token. Admission, program
  formation, preparation, and cache validation consume the same snapshot
  instead of maintaining separate support tables. A program retains only the
  semantic capability facts needed by its target profile, not the generation
  token.

**Backend generation**
: A token identifying one valid lifetime of a backend context or device. Old
callbacks, materializations, and prepared work cannot mutate a newer generation.

**Boundary**
: A conceptual point where responsibility changes. It does not by itself imply
  a thread, process, network, message, or copy.

**Boundary-binding recipe**
: A structural description of how one invocation's live inputs, outputs, and
  other per-call values fill the external slots of a reusable executable
  program.

## C

**Capability**
: A truthful backend fact, such as a supported data type, buffer limit,
  workgroup limit, vector instruction feature, or thread availability.

**Capability fingerprint**
: A stable identity for the semantic capability facts relevant to program
  preparation. It excludes the separate backend-generation token, which is
  also required for prepared and invocation identity.

**CompiledCallable**
: An optional frontend adapter that uses complete guards to select direct reuse
  of an existing executable program and otherwise invokes the whole ordinary
  callable.

**Compute domain**
: An executable program domain naming one selected numerical backend family and
  the target-profile assumptions under which its computations are legal.

**Contract**
: The requests, results, and rules exchanged across a responsibility boundary.

## D

**Demand region**
: The finite, not-yet-materialized data and effect closure selected for named
  roots that must make progress.

**Demand root**
: A value or effect made necessary by observation, data-dependent host control,
  explicit transfer, a value-requiring callback, mandatory effect progress, or
  scoped synchronization.

**DerivativeHistory**
: Runtime-owned dynamic derivative recipes, saved logical values and expected
  versions, random-number reservations, callbacks, and use counts for one live
  derivative lifetime.

**Drain**
: Completion of every physical use owned by an execution request. Physical
  resources cannot be reused merely because a logical result was published.

## E

**Effect**
: An observable ordered consequence such as mutation, random-number position,
  gradient accumulation, or optimizer update.

**ExecutableProgram**
: An immutable, structurally hashable, finite value in Tabgrad's common program
  schema. Its discriminator names either one compute domain or one explicit
  source-to-destination transfer domain. It describes selected work,
  dependencies, virtual storage, guards, capabilities, liveness, and provenance
  while excluding physical backend choices.

**ExecutionRequest**
: Per-invocation backend bindings, dynamic values, generation tokens, and
  cancellation state. A transfer request also aggregates its two endpoint
  states and staging lifecycle. It does not contain permanent program or model
  state.

**ExecutionTicket**
: The read-only per-invocation completion view that separates logical result
  publication from final physical drain. For a transfer, these signals aggregate
  every endpoint that actually started. The ticket can share one underlying
  state allocation with the request lifecycle.

## F

**Flat-composition cache**
: A bounded structural cache that forms one flat executable program from
  reusable child-program fingerprints, boundary remaps, new exterior work, and
  a target profile. A hit does not copy every unchanged child computation.

**Frontend**
: The Python or JavaScript/TypeScript public surface that adopts a language's
  conventions and calls the common runtime client contract.

**Fusion**
: A legal transformation implemented as fewer physical kernels or calls to
  reduce dispatch and intermediate storage. It cannot change semantics or ignore
  effects.

## G

**Guard**
: A condition proving that a reusable compiled variant still matches every fact
  that can change semantics or generated work.

## H

**Handle**
: A small stable identifier through which a public tensor refers to runtime-owned
  semantic state. It is not the tensor payload or a backend address.

**Host entry**
: The outermost call from a Python or JavaScript frontend into the runtime before
  control returns to the JavaScript event loop. Nested runtime calls remain
  inside the same host entry.

## I

**Incremental semantic graph**
: The reclaimable collection of admitted operation occurrences, logical values,
  and their data and effect indexes. It is not a persistent captured model
  graph.

**Intermediate representation (IR)**
: Structured computation data intended for inspection and transformation.
Tabgrad has the incremental semantic graph and `ExecutableProgram` as two
different internal descriptions.

## J

**Jacobian-vector product (JVP)**
: A derivative computation that propagates a chosen input direction forward
  without forming the complete Jacobian matrix.

## K

**Kernel**
: A reusable, optimized numerical routine for work such as matrix multiplication,
  normalization, attention, or an elementwise region.

## L

**Logical storage version**
: The semantic version of shared storage observed by a `TensorValue`. It is
independent of a physical buffer address.

**Lowering**
: Translation from a richer computation description to a more concrete one
while preserving its contract. Common semantic lowering produces executable
vocabulary; backend lowering chooses physical implementation.

## M

**Materialization**
: The existence of a logical value's numerical payload in a backend. It does not
imply copying that payload to the frontend.

**MaterializationTable**
: The runtime mapping from a logical storage version and backend generation to
an opaque allocation reference plus readiness and last-writer facts.

## O

**Observation**
: An explicit request to make numerical data available to host code. Observation
can create demand, synchronization, staging, and readback.

**OperationDefinition**
: The canonical rules shared by every occurrence of one operation: arguments,
metadata, data types, devices, aliases, mutation, derivatives, decompositions,
capabilities, and diagnostics.

**OperationRecord**
: One admitted operation occurrence with concrete inputs, outputs, attributes,
dependencies, effects, provenance, and derivative facts.

## P

**PreparedExecutable**
: Opaque backend-private reusable preparation for one compute-domain executable
  program, capability fingerprint, software-version set, and backend generation.
  A transfer-domain program is coordinated across endpoints instead of becoming
  one `PreparedExecutable`. Prepared state is not an invocation in progress.

**ProgramCallRecord**
: A tagged `OperationRecord` specialization representing one fresh semantic
  invocation of a reusable executable program. It does not require a separate
  graph or record store.

## R

**Random-number generator (RNG) reservation**
: A position or interval reserved in semantic order so optimization, dropped pure
work, and asynchronous execution cannot silently change later random results.

**Runtime client contract**
: The language-neutral request surface shared by the Python and
JavaScript/TypeScript frontends.

**RuntimeSession**
: The stateful owner that scopes handles, semantic stores, gradient context,
effects, random-number order, errors, budgets, backend references, and close
lifecycle for one frontend execution environment.

## S

**Schedule**
: An order and grouping of work constrained by data, effects, and release rules.
  The common program owns authoritative dependencies; the backend owns the
  physical schedule.

**Semantic pin**
: A runtime-owned obligation to keep one logical materialization usable until
  its semantic owner releases it.

**Staging lease**
: Temporary physical storage used to move bytes across an explicit boundary. A
  transfer coordinator owns its lifetime, while the supplying backend owns its
  allocation; it cannot be released until every endpoint that started has
  drained and no longer uses it.

**StorageState**
: Shared logical storage and alias identity, current mutation version, and
  ordered writer/effect state.

## T

**Target profile**
: The backend-family and semantic capability assumptions recorded in an
  executable program. It excludes a particular physical generation, compiler,
  kernel, buffer, or address.

**TensorState**
: Stable public tensor and differentiable-leaf identity, current logical value,
public lifetime, and gradient attachment points.

**TensorValue**
: One immutable logical version with shape, data type, device, layout or view,
producer, dependencies, and observed storage version.

**Transfer domain**
: An executable program domain declaring one source backend, one destination
  backend, their byte and layout contract, and completion dependencies. The
  runtime coordinates its endpoint operations; it is not a third numerical
  backend or hidden fallback.

**Transport adapter**
: A small mechanism that carries the runtime client contract through direct
calls, Pyodide, or a worker without owning tensor semantics.

## V

**Vector-Jacobian product (VJP)**
: A derivative computation that propagates an incoming output gradient backward
  toward inputs without forming the complete Jacobian matrix.

## W

**WebAssembly**
: The browser execution format used by Tabgrad's central-processing-unit
numerical backend, including compiled scalar and vectorized kernels.

**WebGPU**
: The browser graphics-processor interface used by Tabgrad's accelerator
backend.

**WebGPU Shading Language (WGSL)**
: The language used for WebGPU kernels.

**Web Worker**
: An optional browser deployment mechanism for moving coordination or CPU work
off the page's main thread. It is not an architectural layer or numerical
backend.

# Core DI Kernel Prototype

## Decision

Design a new internal package, `@pluxel/core-di`, as a graph-first DI kernel for plugin orchestration.

This package should not be shaped as a generic container library. It should be shaped around:

- explicit declarations
- inspectable graph snapshots
- incremental graph compile
- minimal runtime instance caching

Detailed design lives in [`packages/core-di/DESIGN.md`](../../../packages/core-di/DESIGN.md).

The next plugin-biased architecture direction is documented in
[`plugin-biased-v2.md`](./plugin-biased-v2.md).

## Why a new package

`diod` currently works for `@pluxel/core`, but the fit is partial:

- some generic DI concepts are not useful for Pluxel's real plugin/runtime model
- some important Pluxel concerns live outside the DI kernel instead of being reflected in the model
- the implementation already contains multiple core-specific adaptations around `diod`, which is a sign that the abstraction boundary is not ideal

This document proposes a new internal package, `@pluxel/core-di`, as a place to design the next kernel deliberately instead of continuing to deform `diod`.

The goal is not "rewrite `diod` with different names".

The goal is:

- keep the kernel small
- keep semantics explicit
- make incremental graph updates part of the design, not an afterthought
- optimize for `@pluxel/core` plugin/runtime orchestration first

## Concrete design choices

The prototype now makes these concrete choices:

- graph-first rather than container-first
- explicit dependencies only
- no provider-local container accessor API
- strict token conflict handling only
- minimal cache semantics: `retain` or `fresh`
- runtime instance store is explicit and inspectable
- build/admin paths may return results; hot runtime paths should stay lean

This is a deliberate break from "general-purpose DI ergonomics".

## Status

Current status is active refactor:

- `@pluxel/core-di` already backs the core plugin runtime
- API is intentionally not stabilized
- internal data layout is still free to change while benchmarks improve
- `diod` remains the comparison target, not the active core runtime implementation

## Non-goals

- not a drop-in compatible `diod` replacement
- not a general-purpose enterprise DI framework
- not a decorator-driven magic container
- not a request-scope/web-framework container
- not a "feature complete" surface that preserves every current DI concept

## Design principles

### 1. Light kernel, rich outer orchestration

The kernel should only own what it can model cleanly:

- declarations
- resolution graph
- verification
- instance lifetime semantics needed by core

Outer orchestration should own:

- plugin lifecycle start/stop/restart
- HMR policies
- rollback/commit policy
- logging
- config injection

The kernel should expose enough structure so outer layers can do these jobs well without patching internals.

### 2. External visibility is a first-class requirement

The DI kernel is not only an instance resolver. In Pluxel it must also be inspectable.

Outer code should be able to read:

- canonical identifiers
- dependency edges
- reverse dependency edges
- declaration metadata relevant to orchestration
- build deltas

These should be explicit outputs, not private implementation details recovered through casts or side channels.

### 3. Incremental by default

Small graph changes should not require rebuilding everything conceptually or structurally.

The kernel should model:

- adds
- removes
- replacements
- alias updates
- affected-subgraph recomputation

Incrementality should be part of the core contract, not an optimization pass glued onto a generic builder.

### 4. Explicit beats implicit

Prefer:

- explicit dependencies
- explicit aliases
- explicit conflict rules
- explicit metadata shape

Avoid:

- reflection-heavy autowire as the default contract
- multiple overlapping resolution APIs
- policy branches that multiply behavior without clear value

### 5. Model the graph, not only the container

For core, the valuable object is not just "a container that can get instances".

The valuable object is:

- a declaration graph
- a verified runtime graph
- a delta between graph versions

The new package should therefore bias toward graph snapshots and graph transitions, with instance resolution as one capability inside that model.

## Proposed kernel shape

The prototype should aim for three layers.

### A. Declaration layer

Responsibilities:

- register nodes
- unregister nodes
- replace nodes
- attach explicit dependencies
- attach exposed tokens
- emit deterministic deltas

Likely outputs:

- draft declaration graph
- committed declaration graph
- change set since last seal

### B. Verification/index layer

Responsibilities:

- missing dependency detection
- cycle detection
- token conflict detection
- canonical node resolution
- forward and reverse graph indexing
- affected-subgraph computation for small deltas

Likely outputs:

- verified graph snapshot
- alias index
- dependents index
- affected node set for a delta

### C. Resolution layer

Responsibilities:

- instantiate declared providers
- cache by supported lifetime semantics
- expose a minimal accessor API

This layer should be intentionally smaller than current `diod`.

## Plugin-oriented data model

The new kernel should explicitly distinguish:

- `NodeKey`
  Canonical internal provider identity.
- `Token`
  Public dependency handle that resolves to a node.
- graph snapshot
  Verified immutable graph artifact.
- delta
  Structured change set between committed snapshots.
- instance store
  Visible runtime cache, controlled by outer orchestration.

This matters because plugin replacement and forking need "same public handle, different internal node" semantics.

## Runtime model

The runtime should not behave like a generic service locator.

The important contract is:

- declarations become a verified graph
- verified graph can compile fast activators
- runtime can materialize one node and its explicit deps
- outer orchestration can inspect and evict cached instances directly

That is enough for plugin start/stop/restart without importing request scope, tags, or private visibility concepts.

## Concepts that likely remain useful

- provider registration by identifier
- class/factory/instance providers
- explicit dependencies
- token exposure with strict conflict handling
- retained instance caching where core truly needs it
- build-time verification

## Concepts that are intentionally suspect

These are not banned forever, but should not be kernel defaults without a strong reason:

- autowire by reflection
- request scope
- tag systems
- private/public service visibility
- multiple token conflict policies
- dual `Maybe` and `Result` access surfaces
- builder-specific singleton semantics leaking as an accidental workaround

## Expected differences from `diod`

The prototype should differ from `diod` in direction, not just implementation detail.

Expected shifts:

- graph-centric instead of container-centric
- explicit incremental compile instead of generic invalidation plus caches
- outer inspection as public API
- fewer concepts in the core surface
- no container accessors inside providers
- less dependence on "fluent DI framework" ergonomics

## Integration target

The first real consumer is `@pluxel/core` plugin orchestration.

That means the design must support:

- stable plugin identifier normalization
- dependents traversal for restart/unload
- replace semantics for HMR
- draft/commit workflows
- instance cache visibility for orchestration

The design must also support "public token retargeting, internal node replacement" cleanly.
That is the core reason for separating `Token` from `NodeKey`.

If a concept does not help these flows or materially improve standalone use, it should be questioned.

## Suggested implementation sequence

1. Keep `diod` as the production path.
2. Build `@pluxel/core-di` as a design-first package with no compatibility promise.
3. Implement declaration graph and verification graph before runtime resolution.
4. Implement a visible instance store instead of hidden singleton caches.
5. Compare the core plugin flows against both kernels.
6. Migrate only after the new package proves simpler and measurably better on real scenarios.

## Current working answers

- The minimum public surface should be graph snapshot plus instance store, not a rich container API.
- Token exposure should be modeled explicitly, not hidden as generic alias metadata.
- V1 lifetime semantics should be reduced to `retain` and `fresh`.
- Resolution should be built on top of a verified graph snapshot, not mixed into declaration mutation.
- Draft/build/commit belongs in the kernel; lifecycle stop/start policy does not.

# Core DI Kernel Design

## Positioning

This internal kernel is not designed as a generic DI container.

It is a graph-first kernel for `@pluxel/core` plugin orchestration:

- declarations are explicit
- graph state is inspectable
- updates are incremental
- instance caching is minimal and visible

The kernel should be small enough to reason about, but strong enough that outer orchestration no longer needs to patch around hidden container internals.

## Core decisions

## Plugin-biased assumptions

This kernel is allowed to bias toward the Pluxel plugin system instead of serving as a general DI container.

That means the design can assume:

- dependencies are explicit
- providers are mostly plugin classes or plugin factories
- cache policy is mostly `retain`
- tokens are usually plugin ctors, abstract base ctors, or a small number of symbols
- most commits mutate a very small subset of nodes
- important operations are:
  - register one plugin
  - unregister one plugin
  - replace one plugin implementation
  - retarget one base token to another implementation
  - resolve a running plugin fast
  - walk dependents fast for restart/teardown

It does **not** need to optimize for:

- arbitrary tag queries
- request scope
- runtime service locator APIs inside providers
- very dynamic ad hoc factory access patterns

This bias is intentional. It is how we buy simplicity and hot-path speed.

### 1. Graph-first, not container-first

The primary product of the kernel is a verified graph snapshot, not an opaque resolver object.

The graph snapshot must expose:

- canonical node keys
- token to node resolution
- forward dependency edges
- reverse dependency edges
- declaration metadata
- build delta from the previous committed graph

Resolution exists inside this model, but is not the center of the design.

### 2. Explicit dependencies only

The kernel does not pass a container accessor into providers.

A provider must declare all dependencies up front. Resolution then supplies those dependencies positionally.

This removes:

- hidden runtime dependencies
- ad hoc factory-time graph walks
- the need for dual `get` / `getResult` / `getMaybe` style surfaces

For plugin use, this is a better fit than a generic service locator API.

### 3. Separate internal node identity from exposed tokens

The design should distinguish:

- `NodeKey`
  The canonical internal identity of one provider node.
- `Token`
  A public handle that dependencies may reference.

This is important for HMR and replacement.

When one plugin implementation replaces another, the new node can keep serving the old tokens without pretending that the old node key and the new node key are the same thing.

### 4. Incremental compile is a core feature

The kernel should treat graph update as a compile problem:

- apply declaration ops
- patch token ownership
- compute affected closure
- re-verify only what changed
- patch dependency and dependent indices
- emit a delta

This is not an optimization add-on. It is the default workflow.

### 5. Instance cache is a visible store, not hidden container state

The kernel should not hide runtime instances behind an internal singleton map.

Instead it should expose a small instance store abstraction that outer orchestration can inspect and control.

This is required for:

- stop-before-commit flows
- replace/restart semantics
- failed-start cleanup
- runtime status observation

## Minimal vocabulary

### Token

A token is something a dependency may reference.

For plugins, likely tokens are:

- plugin constructor
- abstract base constructor
- symbol token

Strings may still exist for selected host-level identities, but should not be the default for plugin dependencies.

### Node

A node is one declared provider with:

- one canonical `NodeKey`
- zero or more exposed tokens
- one provider body
- one dependency list
- one cache policy
- one metadata payload

### Graph snapshot

A graph snapshot is the verified, indexed, read-only result of one compile.

It should be immutable from the point of view of outer consumers.

### Delta

A delta is the normalized change set between the previous committed graph and the next verified graph.

At minimum it should classify:

- added nodes
- removed nodes
- replacement pairs (`from -> to`)
- retargeted tokens
- affected nodes

### Instance store

The instance store is the runtime cache attached to a graph lineage.

It should support:

- `peek(nodeKey)`
- `has(nodeKey)`
- `set(nodeKey, value)`
- `delete(nodeKey)`
- `deleteMany(nodeKeys)`
- iteration for observability

Outer orchestration remains responsible for lifecycle semantics.

## Proposed object model

### Provider declaration

The provider declaration should be closer to a compiled registration record than a fluent container API.

Proposed shape:

```ts
type Token = abstract new (...args: any[]) => unknown | symbol | string
type NodeKey = object | Function | symbol

type CachePolicy = 'retain' | 'fresh'

type ProviderDecl<T = unknown, M = unknown> = {
	key: NodeKey
	tokens?: readonly Token[]
	deps?: readonly Token[]
	cache?: CachePolicy
	meta?: M
	create:
		| { kind: 'class'; value: new (...args: any[]) => T }
		| { kind: 'factory'; value: (...deps: readonly unknown[]) => T }
		| { kind: 'value'; value: T }
}
```

Important consequences:

- no autowire contract in the kernel
- no provider-local container API
- no hidden dependency resolution
- factory and class providers share the same explicit dependency model

### Draft registry

The draft registry owns mutable slot-backed declaration state.

Responsibilities:

- add or replace declaration by node key
- remove declaration by node key
- support in-place key replacement when plugin implementation identity changes
- reuse stable slots across revisions
- record dirty slots
- support reset to the last sealed baseline

Suggested API direction:

```ts
const draft = registry.draft()

draft.put(decl)
draft.remove(nodeKey)

const build = draft.build()
if (build.ok) {
	build.commit()
} else {
	build.reset()
}
```

The point is not the exact method names.

The point is:

- mutation is staged
- build returns a concrete artifact
- commit is explicit
- reset is explicit

### Verified graph snapshot

The verified snapshot should expose only read operations:

```ts
type GraphSnapshot<M = unknown> = {
	revision: number

	resolve(token: Token): NodeKey | undefined
	resolveSlot(token: Token): number | undefined
	has(nodeKey: NodeKey): boolean
	declaration(nodeKey: NodeKey): GraphNode<M> | undefined
	depsOf(nodeKey: NodeKey): readonly NodeKey[]
	dependentsOf(nodeKey: NodeKey): readonly NodeKey[]
	consumers(token: Token): readonly NodeKey[]
	keys(): IterableIterator<NodeKey>
}
```

This snapshot is the primary artifact outer layers consume.

### Runtime resolver

The runtime resolver should be intentionally small.

Suggested direction:

```ts
type Runtime<M = unknown> = {
	graph: GraphSnapshot<M>
	instances: InstanceStore

	peek<T>(tokenOrKey: Token | NodeKey): T | undefined
	ensure<T>(tokenOrKey: Token | NodeKey): T
	delete(tokenOrKey: Token | NodeKey): void
}
```

Key point:

- `ensure()` is a hot-path operation over a verified graph
- error-heavy result wrappers should stay on build/admin paths, not on the hottest runtime path

## Build and compile pipeline

The compile pipeline should work like this.

## Current benchmark signal

The current benchmark entry is:

- `pnpm --filter @pluxel/core bench:di`

It compares the internal DI kernel against the archived workspace `diod` implementation on a few
core-relevant scenarios.

Current signal after the slot-state refactor is positive across the measured scenarios:

- cold full build and cold build-plus-first-resolve are faster than `diod`
- hot no-op build is substantially faster
- structural edits like add/remove leaf and base retarget are now slightly faster instead of slower
- retained singleton resolve is again slightly faster
- transient resolve remains materially faster

That means the remaining work is now refinement, not a fundamental layout reversal.

## Current architecture direction

The current implementation has already moved to the V2 shape:

- draft state is slot-backed
- committed state is slot-backed
- verified snapshots are slot-backed
- external graph access is query-first rather than map-first

The important remaining rule is to keep the external API query-first while allowing the internal
slot tables to keep evolving.

The graph is split into two layers:

### 1. Static declaration layer

Per-node immutable declaration data:

- key
- exposed tokens
- dep tokens
- create plan
- meta
- cache policy

This layer should only change when that node's declaration itself changes.

### 2. Dynamic resolution layer

Per-revision data derived from token ownership:

- token -> key index
- resolved dependency edges
- reverse dependents

This layer changes when aliases or providers move, but should not force rebuilding all node records.

In the current implementation, that split is realized as:

- slot-indexed declaration tables in draft and committed state
- slot-indexed resolved dependency tables in snapshots
- slot-indexed reverse dependents and token consumers stored as arrays
- implicit self-token ownership so the explicit token index only stores retargetable aliases
- lazy activator compilation from `create + resolved dep slots`
- runtime token resolution that can go directly to slot and then to cached instance

This matters because plugin runtime code reads graph state through query methods first, while the
internal layout stays tuned for small structural edits.

### 1. Apply staged declaration ops

Draft mutations update:

- slot-backed declaration state
- dirty slot set

No verification happens here.

### 2. Patch token ownership for touched slots

For each touched slot:

- remove previous token ownership
- insert next token ownership
- collect retargeted tokens

Token conflicts are always strict errors.

There should be no `firstWins` or `lastWins` policies.

### 3. Compute affected closure

Affected closure includes:

- dirty slots themselves
- previous dependents of dirty slots
- any nodes whose token resolution changed because a token was retargeted

This is the subgraph that may need re-verification and edge patching.

### 4. Resolve dependency tokens to canonical nodes

Each touched or affected slot resolves dependency tokens through the new token index.

This produces:

- canonical dependency edges
- missing dependency errors when a token no longer resolves

### 5. Verify cycles only within the affected closure

Cycle detection should run over the affected closure plus any changed edges entering that closure.

The kernel should not rescan the whole graph unless the update genuinely invalidates the global assumptions.

### 6. Patch forward and reverse indices

After successful verification:

- update resolved dependency slot arrays
- update reverse dependent slot arrays
- update per-node compiled activators if needed

### 7. Emit `BuildArtifact`

The build artifact should contain:

- `graph`
- `delta`
- `commit()`
- `reset()`

This mirrors current core needs without forcing lifecycle policy into the kernel.

## Delta semantics

The delta should be more precise than raw mutation logs.

Suggested shape:

```ts
type GraphDelta = {
	added: readonly NodeKey[]
	removed: readonly NodeKey[]
	replaced: readonly { from: NodeKey; to: NodeKey }[]
	affected: readonly NodeKey[]
	retargetedTokens: readonly {
		token: Token
		from?: NodeKey
		to?: NodeKey
	}[]
}
```

Why this matters:

- restart planning can use `affected`
- HMR compatibility can use `retargetedTokens`
- replacement planning can distinguish `from -> to` directly instead of inferring it from
  unrelated add/remove entries
- observability tools can explain what changed without diffing entire snapshots

## Cache and lifetime semantics

V1 should keep cache semantics minimal:

- `retain`
  Cache instance by canonical node key until outer orchestration deletes it.
- `fresh`
  Never cache.

This is enough for plugin use.

V1 should not include:

- request scope
- per-build singleton
- private container-local scope variants

If a future need appears, it should justify itself against plugin orchestration reality, not DI tradition.

## Provider activation strategy

To keep runtime fast, the graph build may precompile activators per node.

Examples:

- `class` provider with 0 deps becomes `() => new Ctor()`
- `class` provider with 1 dep becomes `(store) => new Ctor(store.ensure(dep0))`
- `factory` provider with 2 deps becomes `(store) => fn(store.ensure(dep0), store.ensure(dep1))`

This keeps the runtime hot path free of:

- per-call dependency arrays for common arities
- container accessor objects
- repeated token normalization when the graph is already compiled

For rare high-arity providers, fallback to a small loop is fine.

## What stays outside the kernel

The following should remain outside:

- plugin context creation
- dependency view wrapping such as parent `ctx` overlays
- lifecycle start/stop/restart
- config validation and injection
- feature declaration policy
- runtime logging
- stop ordering policy
- retry policy after failed starts

The new kernel should make these easier, but should not absorb them.

## Rejected directions

### Fluent registration as the primary API

It looks nice in demos, but it pushes the implementation toward a container library mental model.

For core, a declaration record API is clearer and easier to diff.

### Autowire-first design

It saves a few keystrokes but weakens the graph contract.

For plugin orchestration, explicit deps are better.

Reflection support, if it exists at all, should be an outer convenience layer that compiles into explicit declarations.

### Hidden alias semantics

Alias or token retargeting is too important to hide behind generic registration metadata.

The build artifact should expose token retargeting directly.

### Dual error surfaces

The kernel should not expose both `Maybe` and `Result` flavors of the same operations.

Build/admin paths can be result-based.
Hot runtime paths can be assertion-based over a verified graph.

## Suggested implementation order

1. Implement declaration registry and op log.
2. Implement token index and strict conflict verification.
3. Implement dependency and dependent graph patching.
4. Implement affected-closure computation.
5. Implement immutable graph snapshot and delta emission.
6. Implement minimal runtime instance store.
7. Add activator compilation for the hot path.
8. Compare plugin lifecycle paths against the current `diod`-based implementation.

## Success criteria

The new package is successful only if it is clearly better on all three axes:

- simpler object model
- easier outer orchestration
- equal or better performance on real plugin graph scenarios

If it only changes APIs without reducing conceptual weight in core, it is not a good redesign.

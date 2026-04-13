# Core DI V2: Plugin-Biased Architecture

## Goal

Design the next `@pluxel/core-di` architecture specifically for the Pluxel plugin system.

The target is not a generic DI framework.

The target is:

- fast plugin graph commits
- fast plugin instance resolution
- correct replace/restart/unregister semantics
- explicit, inspectable runtime state

This document exists because current benchmark results show a split:

- hot resolution paths are already competitive
- structural graph edits are still too expensive

That means the next step must be an architecture change, not another round of helper-level tuning.

## What The Plugin System Actually Needs

Based on current `@pluxel/core` usage, the kernel only needs to optimize these operations:

1. register one plugin provider
2. unregister one plugin provider
3. replace one plugin implementation while keeping old tokens resolvable
4. retarget an abstract base token to another implementation
5. resolve one plugin instance fast
6. compute reverse dependents fast for stop/restart cascades
7. notify optional-dependency watchers when runtime availability changed
8. replace one plugin implementation in place while preserving old constructor token aliases

It does not need to optimize for:

- request scope
- tags
- public/private visibility
- provider-local container/service-locator access
- arbitrary alias conflict policies
- runtime graph edits from inside arbitrary factories

Those concepts should stay out of the kernel unless Pluxel core demonstrates a real need.

## Design Constraints

### 1. Explicit deps only

No autowire in the kernel.

Every node declares dependency tokens up front.

### 2. Canonical key first

Runtime cache, lifecycle, and stop/restart orchestration are keyed by canonical node key.

Tokens are only lookup handles.

### 3. Most nodes are retained

Plugin providers are mostly `retain`.

`fresh` exists, but the design should optimize for retained nodes first.

### 4. Most commits are tiny

The common commit is:

- add one plugin
- remove one plugin
- replace one provider
- retarget one base token

The graph may be large, but the mutation set is small.

This should shape the data layout.

## Root Cause Of Current Structural Cost

The current prototype stores too much per-node resolved state together:

- node declaration data
- resolved dependency edges
- reverse dependents
- compiled activators

That makes structural edits expensive because token retargeting forces the system to rebuild or patch too much state at once.

In plugin terms:

- changing who provides `Abs`
- should patch the edge tables
- but should not require rebuilding every consumer node object unless the consumer declaration changed

That is the key design correction for V2.

## V2 Architecture

Split the graph into two layers.

### A. Static declaration layer

Per-node immutable declaration record:

```ts
type NodeDecl<M = unknown> = {
  key: NodeKey
  tokens: readonly Token[]
  depTokens: readonly Token[]
  cache: CachePolicy
  meta: M | undefined
  create: ProviderCreate<unknown>
}
```

Properties:

- changes only when that node declaration changes
- independent from current token ownership
- reusable across revisions

This is where plugin metadata belongs.

### B. Dynamic resolution layer

Per-revision derived indices:

```ts
type ResolutionState = {
  tokenIndex: ReadonlyMap<Token, number>
  resolvedDeps: readonly (readonly number[] | undefined)[]
  dependents: readonly (readonly number[] | undefined)[]
  tokenConsumers: ReadonlyMap<Token, readonly number[]>
}
```

Properties:

- changes when token ownership changes
- changes when node dep tokens change
- should be patchable for small deltas
- should not force rebuilding static declaration objects

Current implementation note:

- draft state, committed state, and verified graph snapshots are all slot-backed now
- static declaration identity is reused when only token targeting changes
- resolved deps and reverse dependents are patched separately from declaration identity
- external graph access is query-first rather than map-first
- draft states are sealed at build time and switch to copy-on-write on later draft edits
- graph artifacts no longer pay pervasive runtime `Object.freeze()` cost; revision ownership is the
  isolation boundary instead
- a node's own key token is implicit, so alias indexing only stores real retargetable tokens
  such as base abstractions or compatibility aliases
- reverse dependents / token consumers are arrays rather than sets because plugin runtime hot paths
  overwhelmingly traverse them; array copy cost is materially lower on leaf add/remove churn
- runtime token resolution can go directly from token to slot and then to the canonical key/cache

This is not the final zero-copy structural-edit model yet, but it is the first implementation
step that actually moves the codebase toward the V2 split instead of only documenting it.

## Snapshot Shape

`GraphSnapshot` should become more explicit:

```ts
type GraphSnapshot<M = unknown> = {
  revision: number

  resolve(token: Token): NodeKey | undefined
  resolveSlot(token: Token): number | undefined
  has(key: NodeKey): boolean
  declaration(key: NodeKey): NodeDecl<M> | undefined
  depsOf(key: NodeKey): readonly NodeKey[]
  dependentsOf(key: NodeKey): readonly NodeKey[]
  consumers(token: Token): readonly NodeKey[]
  keys(): IterableIterator<NodeKey>
}
```

Important consequence:

- `node().deps` should stop being the primary contract
- resolved dependencies become an edge-table query, not embedded node payload

That is a better fit for plugin runtime orchestration anyway.

## Compile Strategy

### Static layer update

When draft mutations happen:

- touched node declarations are replaced or removed
- untouched node declaration records are reused by reference

### Dynamic layer update

For each build:

1. patch token ownership only for touched nodes
2. compute retargeted tokens
3. use `tokenConsumers` of those tokens to find affected consumers
4. recompute only `resolvedDeps` for:
   - touched nodes
   - direct/indirect consumers affected by retargeted tokens
5. patch reverse dependents only for affected nodes

This means:

- declaration rebuild scope and edge rebuild scope are separate
- token retarget no longer implies node object recreation
- replacement can be expressed directly as `from -> to` rather than inferred from separate add/remove

## Runtime Strategy

Runtime should compile activators lazily from:

- static `create`
- dynamic `resolvedDeps`

That keeps cold build cheaper while preserving hot resolve performance.

The runtime cache remains:

- explicit
- keyed by canonical node key
- externally inspectable by `PluginService`

## Plugin-Specific Optimizations Allowed

These are acceptable design biases:

### 1. Strict one-owner token policy

No `firstWins` / `lastWins`.

Conflict is always an error.

### 2. Canonical key cache only

Do not cache by token.

Resolve token to key, then operate only on key.

### 3. No general service-locator surface

Runtime only needs:

- `peekByKey`
- `peekByToken`
- `ensureByKey`
- `ensureByToken`
- `delete`

No `Maybe`/`Result` variants on the hot path.

### 4. Commit-oriented draft model

Keep:

- `put`
- `remove`
- `reset`
- `build`
- `commit`

Do not grow a full generic builder DSL.

### 5. Dependents-first orchestration support

Reverse dependency access is a first-class kernel concern because plugin stop/restart depends on it.

## API Adjustments Needed In Core

To fully unlock V2, `@pluxel/core` should stop assuming resolved deps live on the node object.

Current call sites that conceptually want edge data should migrate toward:

- `graph.declaration(key)`
- `graph.depsOf(key)`
- `graph.dependentsOf(key)`

That keeps the kernel free to evolve internal node storage without leaking the wrong shape.

This is a good migration because it is also semantically clearer.

## Benchmark Targets

The benchmark to beat is not "all scenarios beat diod immediately".

The practical targets for the next architecture revision are:

1. keep `hot resolve transient chain` better than `diod`
2. keep `hot no-op build` at least competitive
3. cut `hot add/remove leaf star` cost by at least 2x from current prototype
4. cut `hot base retarget star` cost by at least 2x from current prototype
5. improve `cold build + first resolve` enough that the plugin-host startup penalty is acceptable

If V2 does not improve structural edit benchmarks materially, the architecture still is not right.

## Implementation Order

Recommended order:

1. Introduce `NodeDecl` and split static declaration storage from resolved edge tables.
2. Add `declaration()`, `depsOf()`, and `dependentsOf()` APIs to `GraphSnapshot`.
3. Migrate `PluginService` and helper code to those APIs.
4. Remove reliance on `GraphNode.deps` as a bundled resolved field.
5. Re-run `core-di` vs `diod` benchmark after each milestone.

## Non-Goals For V2

- not preserving old internal shape for compatibility
- not adding adapter layers to keep container terminology alive
- not chasing generic DI feature parity
- not adding policy branches for hypothetical future use

If a feature does not help plugin commits, plugin resolution, or plugin lifecycle orchestration, it should stay out.

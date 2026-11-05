## @pluxel/async@1.2.0

### Add explicit async composition primitives

Add independent `limit`, `retry`, `singleflight`, and `wait` subpaths without runtime dependencies. Limit shared or per-key concurrency, explicitly authorize bounded retries, share only in-flight work, and cancel waits using native AbortSignal. Stateful handles close admission and drain accepted work; cancelled waiters do not acquire ownership of shared operations.

Extend `iter` with sequential forEach, find, some, every, and reduce consumers that preserve upstream cleanup and drain semantics. Preserve the existing grfn and iter contracts. Generate all source and published exports with tsdown and validate behavior, public types, and source-free consumption.

Singleflight accepts the operation on `run(key, task)`, sharing the first pending task for each key. Add read-only `get` / `size` and snapshot `drain` so domain coordinators can enforce capacity and mutation ordering without maintaining another task registry. Migrate the workspace Cache coordinator and all async examples to this contract.

### Add standalone async graph and iteration tools

Add zero-dependency `grfn` and `iter` subpaths for compile-once async dependency graphs and bounded, pull-based concurrent iteration.

### Align the official Pluxel release line

Release the public framework packages and official Plugins together at 1.2.0. This is the maintainer's explicit version choice for the currently unpublished release; existing breaking-change descriptions remain part of the release notes. Future releases retain semver-based group bumps, and newly introduced pre-1.0 packages join the current release line.

Independent official Plugin packages use `@pluxel/plugin-*`. Update dependency names, package imports, subpath imports and application declarations together. This naming change preserves Plugin class names, exports and constructor declarations. Core, Host, Services, Workbench and tooling packages retain their existing names. Private Plugins remain workspace-only.

A Plugin's canonical identity includes its package entry. Rebuild consumer artifacts and explicitly review saved configuration, startup intent and Workbench state keyed by the previous identity before deployment; no old-name alias or automatic runtime migration is installed.

Carry forward the unpublished release notes. Earlier Host Dev notes belong to Host-vite; the former Typst Markdown extension belongs to the consolidated Markdown package. Their original explanatory bodies remain available alongside the later migration notes.

## @pluxel/async@1.1.0

### Add explicit async composition primitives

Add independent `limit`, `retry`, `singleflight`, and `wait` subpaths without runtime dependencies. Limit shared or per-key concurrency, explicitly authorize bounded retries, share only in-flight work, and cancel waits using native AbortSignal. Stateful handles close admission and drain accepted work; cancelled waiters do not acquire ownership of shared operations.

Extend `iter` with sequential forEach, find, some, every, and reduce consumers that preserve upstream cleanup and drain semantics. Preserve the existing grfn and iter contracts. Generate all source and published exports with tsdown and validate behavior, public types, and source-free consumption.

Singleflight accepts the operation on `run(key, task)`, sharing the first pending task for each key. Add read-only `get` / `size` and snapshot `drain` so domain coordinators can enforce capacity and mutation ordering without maintaining another task registry. Migrate the workspace Cache coordinator and all async examples to this contract.

### Add standalone async graph and iteration tools

Add zero-dependency `grfn` and `iter` subpaths for compile-once async dependency graphs and bounded, pull-based concurrent iteration.

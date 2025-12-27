# LoaderService Design

## Goals
- Provide a clear orchestration layer between module exports, runtime registration, and persisted enablement.
- Keep HMR batch updates atomic and reversible.
- Maintain a small, consistent surface for other services (HMR, RPC, Extension).

## Architecture
- PluginRegistry: authoritative declaration/runtime/persisted state for plugins.
- ModuleReplacer: handles module replacement lifecycle (declare → overrides → sync → dependent refresh).
- LoaderSupport: runtime resolution, status reporting, dependency inspection, pruning, and batch session.
- AnchorJournal: tracks and restores path anchor state across rollbacks.
- DependencyOverrideApplier: applies persisted constructor parameter overrides after declaration.

## Modules
- `module-replacer.ts`: encapsulates replaceModule and dependent refresh logic (includes export scanning + dep overrides).
- `support.ts`: AnchorJournal, LoaderBatchSession, RuntimeResolver, status/dependency/pruner helpers, shared types.

## Key Flows
- replaceModule
  - Normalize module id.
  - Stop runtime for the old module.
  - Remove old declarations and declare new exports.
  - Apply dependency overrides, then sync runtime for enabled plugins.
  - Refresh direct dependents to avoid stale ctor references.
  - Update path anchors.
- beginBatch
  - Start registry transaction and anchor journal.
  - replaceModule runs inside the transaction.
  - rollback restores registry and anchors; commit finalizes both.

## API Surface
- HMR: `replaceModule`, `beginBatch`, `pruneModule`, `prunePluginByName`.
- Shared API: `loader.api.{runtime,status,deps,registry,anchors,control}`.
  - `runtime`: `resolve`, `isRunning`, `normalizeId`
  - `status`: `snapshot`
  - `deps`: `list`
  - `registry`: `listLoadedNames`, `listRegistered`, `findModuleId`, `findModuleIdByName`, `getCtor`, `getSchema`, `getSchemaSource`
  - `anchors`: `list`, `remove`
  - `control`: `enable`, `enablePersisted`, `deactivate`, `stop`

## Invariants
- anchors only contains modules that currently export at least one plugin.
- Registry declaration state is always consistent with runtime state after commit.
- Dependency overrides are applied only after the module declarations are complete.

## Error Handling
- commitFailed stops runtime for failed constructors without touching persisted enablement.
- Batch rollback restores both declaration and anchor state.

## Performance Notes
- Registry transactions record deltas only (no full map clones).
- Dependent refresh is scoped to direct dependents of replaced constructors.

# PackageService Design

## Goals
- Manage plugin package install/load/unload flows with predictable state.
- Integrate with ScanService, LoaderService, and HMR runtime caches.
- Persist and restore package load state safely across restarts.

## Architecture
- PackageState
  - Tracks loaded packages, issues, blocklist, and dependency index.
  - Builds persisted snapshots and debounced writes.
  - Can temporarily disable persistence during restore.
- PackageRuntime
  - Normalizes module ids.
  - Maintains module cache and name-to-module bindings.
  - Bridges to HMR module cache (prime/drop).
- KeyedLock
  - Ensures per-key exclusive operations for install/load/remove batches.
- File layout
  - `package/types.ts` exports public types shared by state/runtime.
  - `package/internal-types.ts` holds private service types (resolved options).
  - `package/state.ts` owns persisted snapshot construction and dependency index.
  - `package/runtime.ts` owns module cache and HMR cache bridge.
  - `package/loader.ts` owns resolution/import/load flow and restore logic.
  - `package/install-flow.ts` handles install orchestration and error wrapping.
  - `package/installer.ts` wraps package-manager IO and dependency inspection.
  - `package/removal-flow.ts` handles uninstall/remove orchestration and logging.
  - `package/locks.ts` provides per-key exclusivity for async operations.
  - `package/helpers.ts` contains pure helpers for defaults and state normalization.

## Key Flows
- load / loadInstalled
  - Resolve entry (or use provided).
  - Bind module id, import module (cached or fresh).
  - Prime HMR cache and replace module in LoaderService.
  - Register record in PackageState.
- install / installMany
  - Optionally reuse existing dependency if no explicit version.
  - Run package manager once for batch installs.
  - Invalidate scan resolver cache after installs.
- invalidatePackage
  - Drop HMR cache and local module cache.
  - Prune LoaderService runtime state.
  - Clear records/issues and dependency references.
- restore
  - Read persisted state.
  - Re-import cached packages and rehydrate LoaderService anchors.
  - Record issues for failures.

## Concurrency
- Keyed locks prevent duplicate installs/loads for the same spec key.
- Batch operations use stable composite keys to dedupe concurrent requests.

## Error Handling
- PackageServiceError wraps invalid spec, install, resolve, and import failures.
- Load issues are persisted and exposed for retries.
- Missing package resolution triggers auto-install retry when allowed.

## Invariants
- Each package name has at most one bound module id at a time.
- Loaded package records are the source of truth for dependents and inventory.
- Blocklist prevents automatic reload after uninstall/remove until unblocked.

## Performance Notes
- Installer caches installed dependency snapshots briefly and invalidates on install/remove to reduce repeated disk reads.

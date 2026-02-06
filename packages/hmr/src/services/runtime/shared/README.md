# runtime/shared

Small, dependency-free utilities shared across runtime services (Scan/HMR/Package).

This folder exists to keep cross-cutting concerns (caching + resolution) consistent and avoid “one-off” local helpers.

## `cache.ts`

- `resolveCacheLimit(raw, fallback)`: normalizes a config/env input into a non-negative integer.
- `boundedSet(map, key, value, limit)`: a tiny FIFO-ish eviction helper for `Map`.
  - Preserves insertion order so callers can build small “refresh-on-hit” LRU patterns by delete+set.

## `exsolve.ts`

`exsolve` is used as the “single source of truth” resolver in runtime:

- ScanService: resolve workspace and installed package entries.
- HMR: resolve workspace entry fallbacks and run “host-installed” checks.
- PackageInstaller: determine whether a dependency is already installed.

### Cache model

There are two layers:

1) **exsolve cache map** (`ExsolveCache`): the key/value store exsolve uses internally.
   - Prefer sharing a single long-lived map (e.g. `ctx.scanService.resolverCache`) so cache invalidation is consistent.
2) **resolver-instance cache** (grouped + bounded): stores `createResolver()` instances by `(group, key)`.
   - Groups prevent unrelated subsystems from evicting each other’s hot resolvers.
   - Each group is bounded by a small LRU to avoid unbounded memory growth when many base dirs are involved.

### API

- `getExsolveCache(cache?)`: returns the provided cache or a process-global fallback.
- `toDirectoryURLString(path)`: normalizes a filesystem path and converts it to a `file://.../` directory URL string.
  - Use this when building `createResolver({ from })` bases.
- `getCachedExsolveResolver(cache, group, key, create, { limit? })`: returns a cached resolver instance.
  - `limit` bounds resolver instances per group (defaults to `32`).

### Invalidation

If you pass `ctx.scanService.resolverCache` as the `cache`:

- `scanService.invalidateResolverCache()` clears the underlying `Map`, effectively clearing exsolve’s resolve results.
- Resolver instances may still be reused, but their internal cache reads/writes go through the cleared map.


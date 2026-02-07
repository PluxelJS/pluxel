# runtime/shared

Small, dependency-free utilities shared across runtime services (Scan/HMR/Package).

This folder exists to keep cross-cutting concerns (caching + resolution) consistent and avoid “one-off” local helpers.

## `cache.ts`

- `resolveCacheLimit(raw, fallback)`: normalizes a config/env input into a non-negative integer.
- `boundedSet(map, key, value, limit)`: a tiny FIFO-ish eviction helper for `Map`.
  - Preserves insertion order; removes the oldest entry when the limit is exceeded.
- `getOrCreateCachedValue(map, key, create, { limit?, evictIf? })`: caches computed values with bounded eviction
  using a small SIEVE / second-chance policy.
- `getOrCreatePromise(map, key, create, { limit?, evictIf? })`: caches in-flight/resolved promises with bounded
  eviction using the same SIEVE / second-chance policy.
  - `evictIf` can be used to avoid caching “negative” results forever (e.g. `null`).
- `clearSieveState(map)`: clears internal per-map SIEVE state (call this when you call `map.clear()`).

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
   - Each group is bounded by a small SIEVE / second-chance policy to avoid unbounded memory growth when many base dirs are involved.

### API

- `getExsolveCache(cache?)`: returns the provided cache or a process-global fallback.
- `toDirectoryURLString(path)`: normalizes a filesystem path and converts it to a `file://.../` directory URL string.
  - Use this when building `createResolver({ from })` bases.
- `getCachedExsolveResolver(cache, group, key, create, { limit? })`: returns a cached resolver instance.
  - `limit` bounds resolver instances per group (defaults to `32`).

### Invalidation

If you pass `ctx.scanService.resolverCache` as the `cache`:

- `scanService.invalidateResolverCache()` clears the underlying `Map`, effectively clearing exsolve’s resolve results.
- It also emits `runtime:resolverCacheInvalidated` so other long-lived services can drop derived resolution caches.
- Resolver instances may still be reused, but their internal cache reads/writes go through the cleared map.

## `conditions.ts`

Shared export conditions for runtime resolution:

- `PLUXEL_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE`: prefer workspace TS sources (`@pluxel/hmr`, `@pluxel/source`, ...).
- `PLUXEL_DIST_EXPORT_CONDITIONS`: prefer published/built outputs (`import`, `default`, `require`).

## `node-modules.ts`

- `hasNodeModulesPackageJson(nodeModulesDir, packageName)`: checks whether a package has a direct
  `node_modules/<pkg>/package.json` entry (supports scoped packages).
  - Used as a fast-path “host-installed” check when `node_modules` exists (important for pnpm workspace links).

## `vite-id.ts`

Small helpers for normalizing Vite ids/urls:

- `cleanViteUrl(id)`: strips `?query` from a Vite id/url.
- `unwrapViteId(id)`: decodes `/@id/<encoded>` back to the original specifier.
- `fsPathFromViteFsId(id)`: converts `/@fs/` ids into filesystem paths (POSIX + Windows drive paths).
- `isBarePackageSpecifier(specifier)`: shared “is this a bare package specifier?” fast-path for workspace rewrite.

## `resolution.ts`

- `toBasePackage(specifier)`: trims a specifier to its package root (e.g. `@scope/name/subpath` → `@scope/name`).
- `canResolveFromCwd(cwd, specifier, cache, opts?)`: best-effort “is this package available from this cwd?” check.
  - Uses `node_modules/<pkg>/package.json` as a fast path when `node_modules` exists.
  - Falls back to exsolve when `node_modules` is absent (PnP / custom resolvers).
- `getCachedResolver(cache, group, from, opts?)`: returns a cached `exsolve` resolver instance for the given `from` chain.
- `resolveModulePath(resolver, id, { mode?, conditions? })`: resolves a specifier using a consistent policy.
  - `mode: "distPreferEsm"` is deterministic when both `import` and `require` exist.

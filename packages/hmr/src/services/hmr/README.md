# `@pluxel/hmr` (service-side HMR) internals

This folder contains the internal implementation of the service-side HMR pipeline used to hot-reload **TS/ESM plugin source code**.

It is intentionally not a public API surface.

## Goals

- Evaluate plugin TS/ESM in a Vite SSR `ModuleRunner`, then apply changes to the running container via `LoaderService`.
- Keep DI singletons stable across reloads by bridging selected host modules into the runner.
- Batch file changes, compute affected entries, and invalidate caches predictably.
- **CJS policy:** plugin source code stays TS/ESM; any CommonJS dependency must be **explicitly** marked and is executed by Node (not HMR’d).

## High-level flow

1. **Watch**: `HMRService` registers Vite watcher hooks for `change/add/unlink`.
2. **Filter & batch**: only files under configured scan roots are considered; changes are debounced into a batch.
3. **Graph**: `HmrBatchProcessor` computes the affected set and selects “targets” (entry modules) to re-run.
4. **Invalidate**: invalidate both Vite’s SSR `moduleGraph` and the runner’s `evaluatedModules` for affected TS/ESM files.
5. **Execute**: `HmrExecutor` imports each target via the runner (`runner.import(id)`).
6. **Inject**: results are fed into `loader.beginBatch().replaceModule(id, exports)`.
7. **Commit**: `registry.commit()` finalizes the container state; on failure the loader batch is rolled back.

## CJS handling (manual-only)

Plugin source code must be TS/ESM, but it may import dependencies that are CommonJS-only (native bindings, legacy packages, etc.).

### Configuration

Use `hmrService.deps.cjsExternal` to mark CommonJS-only packages:

- Exact match: `cjs-pkg`
- Prefix match: `pluxel-plugin-napi-rs/*` matches `pluxel-plugin-napi-rs/canvas`, `.../pinyin`, etc.

Default value: `['pluxel-plugin-napi-rs/*', '@napi-rs/*']` (see `config.ts`).

### Runtime behavior

- Marked CJS dependencies are **externalized** and executed by the host runtime (Node / `require`).
- They are **not** part of the TS/ESM HMR graph, so:
  - changes inside those CJS packages do **not** trigger HMR
  - updates to those packages require a process restart to take effect

### Why a runner-level interceptor exists

In Vite’s module runner, bare imports are normally fetched from the dev server and evaluated as ESM.
For CJS-only modules this can lead to `ReferenceError: require is not defined`.

To make CJS externals reliable (including workspace subpath exports like `pkg/subpath`), `HmrRunner` intercepts the runner’s `fetchModule` RPC:

- If the requested specifier matches `deps.cjsExternal`,
- resolve it to a real file via `environment.pluginContainer.resolveId` (skipping HMR’s own `resolveId` hook),
- return `{ externalize: fileURL(realpath(resolvedFile)), type: 'commonjs' }` to the runner.

This forces the runner to execute it through the host CJS loader and also avoids duplicate instances by canonicalizing symlinks (`realpath`).

## Bridge modules

`deps.bridgeModules` lists specifiers that must share **singletons** between the host process and the runner (DI tokens, decorators, base classes).

### Required bridge modules

Some core runtime packages are **always** bridged and cannot be disabled via config:

- `@pluxel/core` (and `@pluxel/core/*`)
- `@pluxel/context` (and `@pluxel/context/*`)
- `@pluxel/hmr` (and `@pluxel/hmr/*`)

User config can only append extra bridge modules via `deps.bridgeModules`.

Implementation notes:

- `HmrRunner.bridgeHostModules()` imports these specifiers via native Node import and primes `evaluatedModules` so subsequent runner imports reuse the same exports.
- Do not put CJS-only packages here; bridge is for TS/ESM runtime singletons.

## File structure

- `HMRService.ts`: wiring (Vite server, watcher hooks, cold start, config) + Vite plugin hook used by the runner.
- `pipeline.ts`: batching, graph walk, target selection, cache invalidation, executor (`runAndLoadAll`).
- `runner.ts`: wrapper around Vite `ModuleRunner` + host bridge + CJS `fetchModule` externalize interceptor.
- `environment.ts`: path normalization, id variants, scan-root filtering, workspace-only bare resolution helper.
- `workspace-resolver.ts`: resolves bare imports to workspace entries / installed packages.
- `config.ts`: Vite config builder + dependency config (`bridgeModules`, `cjsExternal`, SSR options).
- `runtime-shims.ts`: runtime shims (e.g. `reflect-metadata`) + scoped `require` shims for those shims.
- `logging.ts`: debug namespaces + timing attribution helpers.
- `internals.ts`: small utilities (debouncer/timer/etc).

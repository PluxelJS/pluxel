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

## Scope filtering

By default, the HMR scope is `roots/**/*.ts` (plus anchors), with `node_modules`/`.d.ts`/`.tsx`/`.jsx` excluded.
You can further isolate plugin HMR from frontend/UI changes by providing:

- `hmrService.include`: explicit glob list (overrides the default `roots/**/*.ts`)
- `hmrService.exclude`: extra glob list appended to defaults

The same include/exclude rules are forwarded to `configSourcePlugin`, so decorator source extraction stays in sync
with the HMR scope (and avoids touching UI/TSX by default).

## Config + Feature metadata extraction (pre-start)

HMR uses `@pluxel/rolldown`'s `configSourceVitePlugin` to extract metadata from **raw TS source** (not downleveled JS):

- `@Config(schema)` → injects `__setConfigSource__(Ctor, field, "...")` for UI schema source.
- `field = this.configs.use(schema)` → injects both:
  - `__setConfigSource__(Ctor, field, "...")` (UI schema source)
  - `__registerConfigSchema__(Ctor, field, schema)` (so the schema is known before plugin start)
- `field = this.features.use(FeatureCtor)` → injects:
  - `__registerUsedFeatures__(Ctor, FeatureCtor)` to lift Feature decorator-required deps to the host plugin definition,
    and to attribute Feature config schema into the host plugin config panel (namespaced keys).

Notes / limitations:

- `configs.use(...)` on `#private` fields is rejected (runtime injection cannot assign to `#private`).
- `features.use(...)` extraction only works for class-field initializers. If you call it dynamically in `init()`,
  use `@UseFeature(FeatureCtor)` / `@UseFeature(F1, F2, ...)` (or call `__registerUsedFeatures__(PluginCtor, FeatureCtor)` at module eval time).

## Misuse checklist

If something "runs" but UI/config/DI looks wrong, check:

- You still need `@Plugin({ name })` on the plugin class (this is the runtime identity + registry entry point).
- Do not read values returned by `this.configs.use(schema)` in the constructor; they are injected later (read in `init()`/methods).
- If a Feature declares config (`@Config` / `configs.use`) or declares decorator-required deps (`pluginMethodDecorator()`),
  make sure it is declared *before start* (`@UseFeature(...)` or a class-field `this.features.use(...)` so configSource can inject `__registerUsedFeatures__`).
  In strict environments you can enable `featureDeclarationPolicy: "error"` to fail fast on this mistake.

## Extra Vite plugins

`@pluxel/hmr` does not ship opinionated transforms (e.g. macros) by default.
Downstream projects may inject additional Vite plugins via:

- `hmrService.vitePlugins: Plugin[]`

## Warmup

Cold-start warmup (scan + eager evaluate a small set of likely entries) is **opt-in**.

- Set `PLUXEL_HMR_WARMUP=1` (or `true`) to enable.

## Dependency optimization

Dep optimization is **disabled by default** (to reduce churn + disk IO in Vite 8 beta).

- Set `PLUXEL_HMR_OPTIMIZE_DEPS=1` to enable the client optimizer (UI).
- Set `PLUXEL_HMR_SSR_OPTIMIZE_DEPS=1` to enable the SSR optimizer (runner).

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
- `globs.ts`: `include`/`exclude` glob normalization helpers.
- `runtime-shims.ts`: runtime shims (e.g. `reflect-metadata`) + scoped `require` shims for those shims.
- `logging.ts`: debug namespaces + timing attribution helpers.
- `async-serial-lock.ts`: minimal async mutex for batches/executor.
- `internals.ts`: small utilities (debouncer/timer/etc).

# Vite-Owned Runtime Routes

状态：提案，准备实现。

本文描述下一轮 runtime-dev / runtime-static / runtime-dynamic 重构目标：宿主始终拥有
Vite，Pluxel 只提供可组合 Vite 插件和可加载的 runtime definition。目标是让 static 与
dynamic 两条路线在宿主使用方式上统一，同时保留它们不同的 plugin loading / HMR 执行模型。

## 背景

当前已经完成的收敛：

- `@pluxel/runtime-dev/vite` 提供 route-neutral Vite 能力：
  - `pluxelRuntimeSourceVitePlugin(...)`
  - `pluxelRuntimeUiBridgeVitePlugin(...)`
- `@pluxel/runtime-static/vite` 提供 static 路线的显式插件：
  - `staticRuntimeSourceVitePlugin(...)`
  - `staticRuntimeUiBridgeVitePlugin(...)`
  - `staticRuntimeHostVitePlugin(...)`
- `@pluxel/runtime-dynamic` 复用 `@pluxel/runtime-dev/vite` 的 source semantics，不再维护独立的
  decorator / configSource / lintGuard Vite 逻辑。

当前仍不够统一的地方：

- static 可以在宿主 `vite.config.ts` 中显式组合 Pluxel 插件。
- dynamic 仍通过 `createLoaderHmrHost(...)` 创建并拥有一个内部 Vite dev server。
- 宿主想传 Vite 配置时，只能把 `vite` 作为 `defineLoaderHmrConfig(...)` 的字段交给 dynamic。

用户期望的最终形态是：static / dynamic 都由宿主 Vite config 组合插件，插件加载一个
`export default defineXxxRuntime(...)` 配置文件，route package 只负责把自己的 runtime 语义
安装到宿主 Vite server。

## 目标

- 宿主拥有唯一 Vite dev server。
- static / dynamic 对外使用方式统一：
  - `defineStaticRuntimeConfig(...)` + `staticRuntimeVitePlugin(...)`
  - `defineDynamicRuntimeConfig(...)` + `dynamicRuntimeVitePlugin(...)`
- 配置文件是普通 TS/JS 模块，默认导出由 `defineXxxRuntimeConfig(...)` 包住的对象。
- route-specific 能力只在 route plugin 内部出现：
  - static：fixed catalog、startup report、static reload、request forwarding。
  - dynamic：workspace diagnose、source execution、watch、module replacement、dynamic commit。
- route-neutral Vite source semantics 继续归 `@pluxel/runtime-dev/vite`。
- 不恢复旧的 helper/options：
  - 不恢复 `runtimeUiBridge`
  - 不恢复 `staticRuntimeVitePlugins`
  - 不恢复 `pluxelRuntimeDevVitePlugin`

## 非目标

- 不把 dynamic 的 module replacement / workspace scan / runner 逻辑塞进 static。
- 不让 `@pluxel/runtime` common 暴露 `./vite`。
- 不在 `@pluxel/runtime-dynamic/vite` 中复制 `@pluxel/runtime-dev/vite` 的 source semantics。
- 不新增第三条 runtime 路线。
- 不为了表面对称而牺牲 dynamic HMR 的 fail-fast 和 singleton safety。

## 目标宿主 API

### Dynamic

宿主 Vite config：

```ts
import { dynamicRuntimeVitePlugin } from '@pluxel/runtime-dynamic/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		dynamicRuntimeVitePlugin({
			config: './pluxel.dynamic.ts',
		}),
		react(),
	],
})
```

dynamic runtime config：

```ts
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic/vite'

export default defineDynamicRuntimeConfig({
	root: process.cwd(),
	configPath: 'packages/plugins/host/pluxel.loader.hmr.jsonc',
	profile: 'plugins-host',
	logsDir: 'packages/plugins/host/logs',
})
```

可选：允许直接传对象，便于测试和 programmatic hosts。

```ts
dynamicRuntimeVitePlugin({
	runtime: defineDynamicRuntimeConfig({
		root,
		snapshot,
	}),
})
```

### Static

宿主 Vite config：

```ts
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		staticRuntimeVitePlugin({
			config: './pluxel.static.ts',
		}),
		react(),
	],
})
```

static runtime config：

```ts
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static/vite'
import { DemoPlugin } from './src/DemoPlugin'

export default defineStaticRuntimeConfig({
	name: 'plugins-host-static',
	plugins: [DemoPlugin],
	runtimeState: {
		mode: 'memory',
		snapshot: { enabled: ['DemoPlugin'] },
	},
	context: {
		http: {
			controlPlane: { web: true, rpc: true, sse: true },
			uiAssets: 'hmr-server',
		},
	},
})
```

Production/static build can opt into packaged UI lowering:

```ts
staticRuntimeVitePlugin({
	config: './pluxel.static.ts',
	uiBridge: command === 'serve' ? false : {},
})
```

`uiBridge` is route plugin config, not a property inside runtime definition. This keeps runtime
definition about runtime state, not transform policy.

## Public Exports

### `@pluxel/runtime-dev/vite`

Keep:

- `pluxelRuntimeSourceVitePlugin(...)`
- `pluxelRuntimeUiBridgeVitePlugin(...)`

No route ownership here. This package is the implementation layer used by route Vite plugins.

### `@pluxel/runtime-static/vite`

Add:

- `defineStaticRuntimeConfig(...)`
- `staticRuntimeVitePlugin(...)`

Keep lower-level explicit plugins during the transition:

- `staticRuntimeSourceVitePlugin(...)`
- `staticRuntimeUiBridgeVitePlugin(...)`
- `staticRuntimeHostVitePlugin(...)`

After migration, decide whether lower-level plugins remain public. The preferred user-facing API
should be `staticRuntimeVitePlugin({ config })`.

### `@pluxel/runtime-dynamic/vite`

Add new subpath:

- `defineDynamicRuntimeConfig(...)`
- `dynamicRuntimeVitePlugin(...)`

This is intentionally not a thin alias of `createLoaderHmrHost(...)`. It installs dynamic HMR into
the host-owned Vite server.

## Runtime Config Shape

Use route-specific config types rather than a single universal config. A universal shape would hide
real differences and recreate boolean branching.

```ts
type StaticRuntimeViteConfig = {
	name: string
	plugins: readonly PluginConstructor[]
	configService?: ConfigServiceConfig
	runtimeState?: RuntimeStateStoreConfig
	context?: CoreContext.Config
	hmr?: false | StaticRuntimeViteHostHmrOptions
}
```

```ts
type DynamicRuntimeViteConfig =
	| DynamicRuntimeConfigFromWorkspace
	| DynamicRuntimeConfigFromSnapshot

type DynamicRuntimeConfigFromWorkspace = {
	root?: string
	configPath?: string
	profile?: string
	env?: Record<string, string | undefined>
	omitPackages?: string[]
	loader?: Omit<LoaderHmrHostConfigInput, 'vite' | 'configPath' | 'profile' | 'env' | 'omitPackages'>
}

type DynamicRuntimeConfigFromSnapshot = {
	root?: string
	snapshot: LoaderHmrWorkspaceSnapshot
	loader?: Omit<LoaderHmrHostOptions, 'snapshot' | 'vite'>
}
```

The Vite plugin owns the actual Vite server and should not accept nested `vite` config inside the
runtime definition. Host Vite config is already the outer config.

## Config Loading

Both route plugins should load config modules through Vite SSR import in dev:

- Resolve `config` relative to `config.root` / Vite root.
- `await server.ssrLoadModule(resolvedConfigPath)` or equivalent Vite 8 environment API.
- Read `default`.
- Validate the result has the route config marker added by `defineXxxRuntimeConfig(...)`.
- Watch the config module and relevant imported modules through Vite module graph.

Do not parse config files manually. Do not invent a parallel TS loader. Vite already owns module
loading in this design.

`defineXxxRuntimeConfig(...)` should be a pure identity function with a non-enumerable or symbol
marker for validation:

```ts
export function defineStaticRuntimeConfig(config: StaticRuntimeViteConfig): StaticRuntimeViteConfig {
	return markStaticRuntimeConfig(config)
}
```

## Vite Plugin Composition

### Common Source Semantics

Both route plugins compose:

```ts
pluxelRuntimeSourceVitePlugin({
	root,
	name: 'pluxel:<route>-runtime-source',
	serverOnlyName: 'pluxel:<route>-runtime-transform',
})
```

This is the only place decorator legacy/config source/lint guard are attached.

### Static Plugin

`staticRuntimeVitePlugin(...)` should internally compose:

- `staticRuntimeSourceVitePlugin(...)`
- optional `staticRuntimeUiBridgeVitePlugin(...)`
- host lifecycle plugin currently represented by `staticRuntimeHostVitePlugin(...)`

Implementation outline:

```ts
export function staticRuntimeVitePlugin(options: StaticRuntimeVitePluginOptions): PluginOption[] {
	return [
		staticRuntimeSourceVitePlugin({ root: options.root }),
		...(options.uiBridge === false ? [] : [staticRuntimeUiBridgeVitePlugin(options.uiBridge)]),
		createStaticRuntimeConfigHostPlugin(options),
	]
}
```

The host plugin:

- loads the static config module
- creates `StaticRuntimeDefinition`
- creates `StaticRuntimeHost`
- installs `installStaticRuntimeHmr(...)` by default in serve mode
- starts host
- proxies `/__pluxel/*` and document navigations
- reloads static runtime when the config module or plugin ctor module changes
- stops host on Vite server close

### Dynamic Plugin

`dynamicRuntimeVitePlugin(...)` should internally compose:

- `pluxelRuntimeSourceVitePlugin(...)`
- dynamic loader HMR install plugin
- dynamic HTTP / route middleware plugin
- dynamic watcher / hot update bridge plugin

The key architectural change: `LoaderHmrService` must stop creating and owning a Vite server. It
should be split into an installable controller that receives a host `ViteDevServer`.

Target split:

```ts
class LoaderHmrController {
	constructor(ctx: Context, config: LoaderHmrConfig)
	attachVite(server: ViteDevServer): void
	start(): Promise<void>
	stop(): Promise<void>
}
```

Existing `createLoaderHmrHost(...)` can remain temporarily as compatibility by creating a Vite
server and then installing the same controller into it. The new primary path is the Vite plugin.

## Dynamic Lifecycle Target

Current lifecycle:

```text
createLoaderHmrHost()
  -> diagnose workspace
  -> create Context
  -> installLoaderHmrRuntime()
  -> LoaderHmrService.start()
       -> create Vite server
       -> listen
       -> execute startup entries
```

Target lifecycle:

```text
host vite.config.ts
  -> dynamicRuntimeVitePlugin({ config })
       configResolved()
       configureServer(server)
         -> load dynamic runtime config via Vite
         -> diagnose workspace or consume snapshot
         -> create Context
         -> installLoaderHmrRuntime(ctx, { server, snapshot })
         -> attach middleware / runner / watchers to host server
         -> execute startup entries after Vite is ready
       handleHotUpdate()
         -> route file changes into loader HMR batch
       closeBundle/server close
         -> dispose Context effects
```

Important: startup must still fail fast if bridge/builtins/singleton invariants fail. Do not turn
dynamic startup into best-effort background work.

## Required Internal Refactor

### 1. Split Vite Server Ownership

`LoaderHmrService.start()` currently creates/starts Vite. Introduce an internal lower-level method:

```ts
await hmr.attachServer(server)
await hmr.startRuntime()
```

or:

```ts
await installLoaderHmrRuntime(ctx, {
	snapshot,
	viteServer: server,
})
```

`installLoaderHmrRuntime(...)` should accept either:

- `viteServer: ViteDevServer` for host-owned Vite
- no `viteServer` for legacy self-owned mode during transition

### 2. Separate Internal Vite Config From Host Vite Config

`buildLoaderHmrViteConfig(...)` should be reduced to reusable pieces:

- source semantics plugin list
- runner plugin
- HTTP plugin
- optimizeDeps defaults
- resolve aliases/conditions

In host-owned mode, route plugin should merge or project these into the host Vite config only where
Vite allows it. Avoid late mutation that surprises user plugins.

### 3. Route Middleware Instead Of Separate Server

Dynamic currently owns server URLs and HTTP plugin through its Vite server. In host-owned mode:

- register dynamic HTTP endpoints through `configureServer(server)`
- keep `/__pluxel/*` route behavior consistent with static
- avoid stealing Vite asset/module requests

### 4. Watch / HMR Integration

Dynamic should use host Vite watcher and `handleHotUpdate`:

- filter by diagnosed watch roots and include/exclude globs
- ignore Vite client UI modules that should be handled by normal Vite HMR
- enqueue plugin source changes into loader HMR batch
- preserve current batch stability APIs and tests

### 5. Config Module Reload

When `pluxel.dynamic.ts` changes:

- reload config module via Vite
- re-diagnose workspace if workspace profile fields changed
- decide whether full restart is required

Initial implementation can require full plugin controller restart for config changes. Document this
as a deliberate first phase rather than attempting partial mutation too early.

## Migration Plan

### Phase 0: Current Clean Baseline

Keep current state:

- route-neutral source Vite logic in `runtime-dev/vite`
- static explicit plugin pieces
- dynamic internal Vite server

This is the baseline for tests before deeper refactor.

### Phase 1: Config Definition Functions

Add pure config functions:

- `defineStaticRuntimeConfig(...)`
- `defineDynamicRuntimeConfig(...)`

Add tests for marker/validation and config module loading helpers. Do not change runtime behavior
yet.

### Phase 2: Static Unified Plugin

Implement:

- `staticRuntimeVitePlugin({ config, uiBridge })`

Migrate:

- `packages/plugins/static-commercial-demo/vite.config.ts`
- relevant docs

Keep lower-level static plugins temporarily.

### Phase 3: Dynamic Vite Subpath Skeleton

Add:

- `@pluxel/runtime-dynamic/vite`
- `dynamicRuntimeVitePlugin({ config })`

Initially it may fail with an explicit error if used in unsupported host-owned mode, but it should
compile and define the target public API. Prefer implementing quickly with an internal controller
behind a feature flag rather than leaving dead API.

### Phase 4: Host-Owned Dynamic Controller

Refactor `LoaderHmrService` / `installLoaderHmrRuntime(...)` so the dynamic plugin can attach to
the host Vite server.

Migrate one smoke host to the new API:

- `packages/plugins/host/src/dynamic.ts` should become a Vite config based host, or
- add a new `packages/plugins/host/vite.dynamic.config.ts` and script first.

### Phase 5: Compatibility Removal

After dynamic Vite plugin works:

- deprecate then remove direct `createLoaderHmrHost(...)` from recommended docs
- keep low-level `installLoaderHmr(...)` for advanced embedding if still useful
- remove dynamic README language saying dynamic has no `./vite`
- update packaging invariant to require `runtime-dynamic.exports['./vite']`

## Test Plan

### Unit / Boundary

- `runtime-dev/vite`:
  - source plugin sets legacy decorators
  - server source transforms only apply in server consumer env
  - UI bridge remains separate
- `runtime-static/vite`:
  - config module loading
  - plugin array composition
  - request predicate
  - start/stop lifecycle
  - reload on definition changes
- `runtime-dynamic/vite`:
  - config module loading
  - workspace profile resolution from config
  - does not expose nested `vite` config inside runtime definition
  - installs source semantics exactly once
  - does not steal normal Vite client HMR

### Integration

- static commercial demo builds and serves with unified plugin.
- dynamic plugins host starts through Vite config and executes startup entries.
- dynamic file change triggers loader replacement, not only Vite client HMR.
- config source extraction works for plugin schemas under both static and dynamic.
- source UI remotes compile under both routes.
- worker HMR remains dynamic-only and falls back correctly in static.

### Packaging

- `@pluxel/runtime-dev` remains private/inlined.
- `@pluxel/runtime-static/vite` imports runtime-dev vite, not rolldown plugins directly.
- `@pluxel/runtime-dynamic/vite` imports runtime-dev vite, not duplicated source semantics.
- `@pluxel/runtime` still has no `./vite`.
- published static/dynamic output does not import `@pluxel/runtime-dev`.

## Design Constraints

- Keep host-owned Vite config authoritative. Do not hide user Vite config inside Pluxel runtime
  definition once the route is a Vite plugin.
- Avoid boolean route switches. Prefer separate static/dynamic plugins with route-specific config
  types.
- Preserve dynamic fail-fast behavior for singleton/runtime bridge correctness.
- Preserve static ability to run without Vite for prebuilt artifacts.
- Use Vite module loading for TS config files; no custom TS config loader.
- Use runtimeState for plugin enablement. ConfigService is for plugin config records.

## Open Questions

- Should `staticRuntimeSourceVitePlugin(...)` and `staticRuntimeHostVitePlugin(...)` remain public
  after `staticRuntimeVitePlugin({ config })` lands, or become internal escape hatches?
- Should dynamic host-owned mode support multiple Pluxel dynamic runtimes in one Vite server? The
  first implementation should probably reject this.
- Should dynamic config changes trigger full restart or support partial workspace snapshot patching?
  Prefer full restart first.
- Should `dynamicRuntimeVitePlugin(...)` expose middleware path options, or always use `/__pluxel/*`
  to match static?

## Success Criteria

- A new user can start either route from `vite.config.ts` without learning `createLoaderHmrHost`.
- The only conceptual difference between routes is plugin loading model:
  - static fixed catalog
  - dynamic workspace/source loader
- Common source/decorator/config extraction behavior has one implementation.
- Tests protect the public shape so helper creep does not return.

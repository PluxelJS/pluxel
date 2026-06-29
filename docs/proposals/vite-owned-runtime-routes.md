# Vite-Owned Runtime Routes

状态：已实现。

Static 和 dynamic runtime 路线都从宿主 `vite.config.ts` 启动。宿主拥有唯一 Vite dev
server；Pluxel route package 只暴露每条路线一个 Vite 插件和一个 runtime config 定义函数。

## Public API

### Dynamic

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

```ts
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic/vite'

export default defineDynamicRuntimeConfig({
	root: process.cwd(),
	configPath: 'packages/plugins/host/pluxel.loader.hmr.jsonc',
	profile: 'plugins-host',
	logsDir: 'packages/plugins/host/logs',
})
```

Dynamic route config does not accept nested Vite config. Host Vite config is the only Vite config
entry.

### Static

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

Static route infers transform policy from Vite command:

- `serve`: source semantics, static host lifecycle, request forwarding, source UI HMR handles.
- `build`: source semantics and packaged UI bridge lowering.

## Boundaries

- `@pluxel/runtime-dev/vite` is an implementation layer. Application hosts import route packages,
  not runtime-dev.
- `@pluxel/runtime-static/vite` exposes only the static config function and route plugin.
- `@pluxel/runtime-dynamic/vite` exposes only the dynamic config function and route plugin.
- `@pluxel/runtime` common does not expose `./vite`.
- Dynamic HMR internals remain under `@pluxel/runtime-dynamic/hmr` for CLI, tests, and internal
  workspace tooling.

## Config Loading

Route plugins load config modules through Vite SSR import:

- resolve `config` relative to Vite root
- call `server.ssrLoadModule(...)`
- read `default`
- validate the marker installed by the matching `defineXxxRuntimeConfig(...)`
- reject Promise defaults and wrong config functions with actionable errors
- restart/reload the route when the config module graph changes

No custom TS config loader exists in the route packages.

## Dynamic Lifecycle

`dynamicRuntimeVitePlugin(...)`:

- contributes route-neutral source semantics
- loads dynamic runtime config through the host Vite server
- diagnoses the workspace profile
- creates the runtime `Context`
- wires loader HMR to the host `ViteDevServer`
- registers dynamic HTTP middleware
- uses host Vite watcher events for loader batches
- restarts the controller on dynamic config changes

Only one dynamic runtime route is allowed per Vite server.

## Static Lifecycle

`staticRuntimeVitePlugin(...)`:

- contributes route-neutral source semantics
- loads static runtime config through the host Vite server
- creates the static runtime host
- wires static source UI HMR handles in serve mode
- forwards `/__pluxel/*` and document navigations to `host.ctx.http.fetch(...)`
- reloads the fixed catalog when the config module graph changes
- stops the host when the Vite server closes

## Success Criteria

- New hosts start either route from `vite.config.ts`.
- Each route has one documented Vite plugin and one documented config function.
- Common source/decorator/config extraction behavior has one implementation.
- Runtime config stays route-specific and small.
- Host Vite config remains authoritative.

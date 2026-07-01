# Vite-Owned Runtime Routes

状态：已实现。

Static 和 dynamic runtime 都应由同一份 route-neutral runtime config 描述。使用 Vite
开发时，宿主 `vite.config.ts` 只负责安装对应 Vite launcher；不使用 Vite 时，direct launcher
直接消费同一份 config 对象。

核心规则：

- `pluxel.static.ts` / `pluxel.dynamic.ts` 是 runtime config，不是 Vite config。
- `vite.config.ts` 是 host-owned Vite config，只安装 `staticRuntimeVitePlugin(...)` /
  `dynamicRuntimeVitePlugin(...)`。
- direct launcher 不按路径加载 config；它只接收应用已经 import 好的 config 对象。
- Vite launcher 才通过 Vite SSR import 按路径加载 config，并拥有 watcher/HMR/build-time lowering。
- static direct launcher 追求 fetch-native/tsdown-minimal；dynamic direct launcher 默认加载 full runtime
  和 dynamic 服务，不追求最小打包。

## Public API

### Dynamic

Route-neutral dynamic runtime config:

```ts
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'

export default defineDynamicRuntimeConfig({
	root: process.cwd(),
	configPath: 'packages/plugins/host/pluxel.loader.hmr.jsonc',
	profile: 'plugins-host',
	logsDir: 'packages/plugins/host/logs',
})
```

Headless/full-runtime launcher:

```ts
import { createDynamicRuntime } from '@pluxel/runtime-dynamic'
import config from './pluxel.dynamic'

const runtime = await createDynamicRuntime(config)
await runtime.start()
```

Vite HMR launcher:

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

Dynamic route config does not accept nested Vite config. Host Vite config is the only Vite config
entry. Dynamic direct startup does not need to be tsdown-minimal; it can load full runtime,
loader, scan, package manager, workspace diagnose, and persistence services by default. Vite HMR
startup uses the same config, plus the host Vite dev server for SSR loading, watcher events, and
module replacement.

### Static

Route-neutral static runtime config:

```ts
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'
import { DemoPlugin } from './src/DemoPlugin'

export default defineStaticRuntimeConfig({
	name: 'plugins-host-static',
	plugins: [DemoPlugin],
	runtimeState: {
		mode: 'memory',
		snapshot: { enabled: ['DemoPlugin'] },
	},
	http: {
		management: true,
	},
})
```

Production/fetch launcher:

```ts
import { createStaticRuntime } from '@pluxel/runtime-static'
import config from './pluxel.static'

const runtime = await createStaticRuntime(config)

export default {
	fetch: runtime.fetch,
}
```

Vite dev/build launcher:

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

Static route infers transform policy from Vite command:

- `serve`: source semantics, static host lifecycle, request forwarding, source UI dev capability.
- `build`: source semantics and packaged UI bridge lowering.

## Boundaries

- `@pluxel/runtime-dev/vite` is an implementation layer. Application hosts import route packages,
  not runtime-dev.
- `@pluxel/runtime-static` exposes static runtime config definition and production launcher.
- `@pluxel/runtime-dynamic` exposes dynamic runtime config definition and direct launcher.
- `@pluxel/runtime-static/vite` exposes the static Vite launcher and may re-export the config helper for compatibility.
- `@pluxel/runtime-dynamic/vite` exposes the dynamic Vite launcher and may re-export the config helper for compatibility.
- `@pluxel/runtime` common does not expose `./vite`.
- Dynamic HMR internals remain under `@pluxel/runtime-dynamic/hmr` for CLI, tests, and internal
  workspace tooling.

## Config Loading

Vite launchers load config modules through Vite SSR import:

- resolve `config` relative to Vite root
- call `server.ssrLoadModule(...)`
- read `default`
- validate the marker installed by the matching `defineXxxRuntimeConfig(...)`
- reject Promise defaults and wrong config functions with actionable errors
- restart/reload the route when the config module graph changes

No custom TS config loader exists in the route packages.

Direct launchers do not load config by path. They consume an already-imported config object:

```ts
const runtime = await createDynamicRuntime(config)
const runtime = await createStaticRuntime(config)
```

This preserves one runtime config shape while keeping Vite SSR import, watcher invalidation, HMR,
and build-time transforms strictly inside the `/vite` launchers.

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
- wires static source UI dev capability in serve mode
- forwards `/__pluxel/*` and document navigations to `host.ctx.http.fetch(...)`
- reloads the fixed catalog when the config module graph changes
- stops the host when the Vite server closes

## Success Criteria

- New hosts can start either route directly from an imported runtime config.
- New hosts can start either route from `vite.config.ts` by pointing the Vite launcher at the same config file.
- Each route has one documented config helper, one direct launcher, and one Vite launcher.
- Common source/decorator/config extraction behavior has one implementation.
- Runtime config stays route-specific and small.
- Host Vite config remains authoritative.

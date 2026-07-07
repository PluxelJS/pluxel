# @pluxel/runtime-static

Static runtime route for fixed plugin catalogs.

Static and dynamic hosts both start from the host-owned `vite.config.ts` when they need a Vite dev
server. Static differs only in the loading model: it consumes a route-neutral runtime config with a
fixed plugin catalog, then applies catalog diffs on config-module reload.

## Public Entry

Use one config function and one Vite plugin:

```ts
// vite.config.ts
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		staticRuntimeVitePlugin({
			config: './pluxel.static.ts',
		}),
	],
})
```

```ts
// pluxel.static.ts
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'
import { DemoPlugin } from './src/DemoPlugin'

export default defineStaticRuntimeConfig({
	name: 'app',
	plugins: [DemoPlugin],
	configService: { mode: 'memory' },
	runtimeState: {
		mode: 'memory',
		snapshot: { enabled: ['DemoPlugin'] },
	},
	persistence: { mode: 'memory' },
	pluginData: { enabled: true },
	management: {
		enabled: false,
		access: { exposure: 'private' },
	},
	logger: { preset: 'core' },
})
```

The runtime config is not a Vite config. The route plugin owns Vite SSR loading, static source
transforms, development host lifecycle, request forwarding, source UI dev capability, and build-time
packaged UI lowering.

Development-only switches, such as disabling the web-management dev bridge, belong to the host
`vite.config.ts`:

```ts
staticRuntimeVitePlugin({
	config: './pluxel.static.ts',
	hmr: { enableWebManagement: false },
})
```

## Headless Host

Static can still run without Vite when it consumes prebuilt plugin UI/worker artifacts:

```ts
import { createStaticRuntime, defineStaticRuntimeConfig } from '@pluxel/runtime-static'

const config = defineStaticRuntimeConfig({
	name: 'app',
	plugins: [DemoPlugin],
	configService: { mode: 'memory' },
	runtimeState: {
		mode: 'memory',
		snapshot: { enabled: ['DemoPlugin'] },
	},
	persistence: { mode: 'memory' },
})
const runtime = await createStaticRuntime(config)

export default { fetch: runtime.fetch }
```

`createStaticRuntime(config)` starts the fixed catalog before it resolves. `runtime.start()` remains
available as an idempotent lifecycle handle, but standalone hosts should not call it a second time.

## Packaging

The production entry is intentionally route-owned and narrow:

- `@pluxel/runtime-static` imports `@pluxel/runtime/register/static` itself.
- Plugin authoring APIs are re-exported from `@pluxel/runtime/authoring`, not from the heavier
  `@pluxel/runtime` top-level entry.
- The static production entry must not import Vite, Rolldown, chokidar, Node transport adapters,
  Vault, or the web-management bundle unless the application explicitly opts into those services.

`@pluxel/runtime-dev` is private and inlined into this package's Vite/HMR output. Published output
must not import `@pluxel/runtime-dev`.

`@pluxel/rolldown` remains external to the `/vite` development entry because it owns the
Rolldown/OXC/Vite and web Module Federation toolchain helpers. It is an optional peer for
development usage, not a production dependency of the fetch runtime entry.

Current remaining optimization target: internal GraphQL and verification still belong to the
default static register. They are valid production capabilities today, but they are the next place
to evaluate opt-in splitting if the minimum worker bundle needs to shrink further.

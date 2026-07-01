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
	http: { management: false },
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

## Packaging

`@pluxel/runtime-dev` is private and inlined into this package's Vite/HMR output. Published output
must not import `@pluxel/runtime-dev`.

`@pluxel/rolldown` remains external because it owns the Rolldown/OXC/Vite and web Module
Federation toolchain helpers.

# @pluxel/runtime-static

Static runtime route for fixed plugin catalogs.

Static and dynamic hosts both start from the host-owned `vite.config.ts` when they need a Vite dev
server. Static differs only in the loading model: it receives a fixed plugin catalog and applies
catalog diffs on config-module reload.

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
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static/vite'
import { DemoPlugin } from './src/DemoPlugin'

export default defineStaticRuntimeConfig({
	name: 'app',
	plugins: [DemoPlugin],
	runtimeState: {
		mode: 'memory',
		snapshot: { enabled: ['DemoPlugin'] },
	},
})
```

The route plugin owns static source transforms, development host lifecycle, request forwarding,
source UI HMR handles, and build-time packaged UI lowering.

## Headless Host

Static can still run without Vite when it consumes prebuilt plugin UI/worker artifacts:

```ts
import { createStaticRuntimeHost, defineStaticRuntime } from '@pluxel/runtime-static'

const runtime = defineStaticRuntime({ name: 'app', plugins: [DemoPlugin] })
const host = await createStaticRuntimeHost(runtime, {
	runtimeState: {
		mode: 'memory',
		snapshot: { enabled: ['DemoPlugin'] },
	},
})

await host.start()
```

## Packaging

`@pluxel/runtime-dev` is private and inlined into this package's Vite/HMR output. Published output
must not import `@pluxel/runtime-dev`.

`@pluxel/rolldown` remains external because it owns the Rolldown/OXC/Vite and web Module
Federation toolchain helpers.

# @pluxel/runtime-dynamic

Dynamic runtime route for workspace-driven plugin loading.

Dynamic owns workspace diagnose, source execution, watch batching, module replacement, package
state, and dynamic commits. Vite ownership stays with the host app.

## Public Entry

Use one config function and one Vite plugin:

```ts
// vite.config.ts
import { dynamicRuntimeVitePlugin } from '@pluxel/runtime-dynamic/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		dynamicRuntimeVitePlugin({
			config: './pluxel.dynamic.ts',
		}),
	],
})
```

```ts
// pluxel.dynamic.ts
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'

export default defineDynamicRuntimeConfig({
	root: process.cwd(),
	configPath: 'pluxel.loader.hmr.jsonc',
	profile: 'dev',
	logsDir: 'logs',
})
```

Runtime config does not accept nested Vite or HMR config. Add React, GraphQL, macros, aliases, and
other Vite settings to the host `vite.config.ts`; loader HMR wiring stays inside the dynamic route.

Direct/headless launch uses the same config object:

```ts
import { createDynamicRuntime } from '@pluxel/runtime-dynamic'
import config from './pluxel.dynamic'

const runtime = await createDynamicRuntime(config)
await runtime.start()
```

## HMR Internals

`@pluxel/runtime-dynamic/hmr` contains internal and CLI-facing workspace diagnose, snapshot, and
loader HMR primitives. Application hosts should prefer `@pluxel/runtime-dynamic/vite`.

During startup the dynamic route:

- diagnoses the workspace profile into a snapshot
- creates the runtime `Context`
- wires loader HMR to the host `ViteDevServer`
- contributes module and dev capabilities to `ctx.runtimeRoute`
- executes startup entries and feeds source changes through the debounced loader batch

## Packaging

`@pluxel/runtime-dev` is private and inlined into this package's Vite/HMR output. Published output
must not import `@pluxel/runtime-dev`.

`@pluxel/rolldown`, `vite`, and runtime kernel packages stay external. Native toolchain packages
must not be bundled into generated runtime-dynamic output.

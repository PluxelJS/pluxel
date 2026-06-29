# @pluxel/runtime-dynamic

Dynamic runtime route for workspace-driven plugin loading.

Static and dynamic routes should keep plugin author behavior aligned, but their HMR orchestration
is intentionally different. Dynamic owns loader HMR: it discovers workspace plugins, tracks source
entries, evaluates changed modules, and can add or remove plugins while the host is running.

## Responsibility

`runtime-dynamic` owns:

- workspace scan, profile resolution, and enabled entry snapshots
- package install, package state, and dynamic plugin loading
- Vite-backed loader HMR and module runtime adapter
- `executeFiles`, batch stability APIs, and dynamic commit tracking
- Tinypool worker watching for plugin workers
- installation of source UI runtime handles during loader HMR startup

It reuses private `@pluxel/runtime-dev` development pieces by inlining them at build time. Shared
source semantics and UI remote compilation stay aligned with static while the dynamic loader model
stays local to this package.

## Vite Model

Dynamic HMR owns a dedicated Vite dev server because it needs Vite's module runner, watcher, SSR
environment, source transforms, and browser UI server as one lifecycle. Callers do not install a
`@pluxel/runtime-dynamic/vite` plugin into an existing Vite server.

Instead, hosts pass Vite config into the loader HMR host:

```ts
import { createLoaderHmrHost, defineLoaderHmrConfig } from '@pluxel/runtime-dynamic/hmr'

const host = await createLoaderHmrHost({
	config: defineLoaderHmrConfig({
		root,
		configPath: 'pluxel.loader.hmr.jsonc',
		profile: 'dev',
		vite: {
			plugins: [/* host-owned Vite plugins */],
		},
	}),
})

await host.start()
```

The internal Vite config composes route-neutral Pluxel source semantics from
`@pluxel/runtime-dev/vite`; dynamic adds only loader-specific runner, HTTP, watch, and execution
plugins.

## Development UI Remotes

During `installLoaderHmr(...)`, dynamic route:

- starts the loader HMR service
- installs the module runtime adapter
- enables runtime HTTP UI assets with `uiAssets: 'hmr-server'`
- enables the runtime extension service
- installs source UI handles backed by the shared compiler

The compiler calls `@pluxel/rolldown/vite/plugin-ui` for web Module Federation remote builds.
Dynamic does not own the MF build implementation.

## Packaging

`@pluxel/runtime-dev` is a private workspace package and is inlined into this package's HMR chunk.
Published output must not import `@pluxel/runtime-dev`.

`@pluxel/rolldown`, `vite`, and runtime kernel packages stay external. Native toolchain packages
must not be bundled into generated runtime-dynamic output.

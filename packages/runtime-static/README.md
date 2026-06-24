# @pluxel/runtime-static

Static runtime route for fixed plugin catalogs.

Static and dynamic routes should expose the same plugin author contract where possible. The
difference is the plugin loading model: static receives a fixed catalog, while dynamic discovers
and mutates plugins at runtime.

## Responsibility

`runtime-static` owns:

- `defineStaticRuntime(...)` for declaring a fixed plugin catalog
- `createStaticRuntimeHost(...)` for preparing a runtime context from that catalog
- startup reports for enabled, disabled, invalid, failed, and missing-dependency plugins
- `reloadStaticRuntime(...)` for applying an already-imported static definition update
- `installStaticRuntimeHmr(...)` for enabling source UI remotes during development
- `staticRuntimeVitePlugins(...)` for the Vite transform stack expected by static hosts
- `staticRuntimeHostVitePlugin(...)` for mounting a static host into a Vite dev server

It does not scan workspaces, install packages, run the dynamic module adapter, or execute changed
plugin source files directly. Those are dynamic route responsibilities.

## Development UI Remotes

For development hosts that want source UI remotes:

```ts
import { createStaticRuntimeHost } from '@pluxel/runtime-static'
import { installStaticRuntimeHmr } from '@pluxel/runtime-static/hmr'
import { staticRuntimeHostVitePlugin, staticRuntimeVitePlugins } from '@pluxel/runtime-static/vite'
```

Use `staticRuntimeVitePlugins(...)` in the host Vite config. In dev, disable
`runtimeUiBridge` when the host installs runtime source handles; enable it for packaged/static
production builds.

After creating a host, call `installStaticRuntimeHmr({ host, viteServer })` before `host.start()`.
This installs only route-neutral source UI handling. Catalog reload remains static-owned and should
still happen through `reloadStaticRuntime(...)`.

Vite hosts can delegate that lifecycle and Fetch bridge wiring to
`staticRuntimeHostVitePlugin(...)`:

```ts
staticRuntimeHostVitePlugin({
	async createHost() {
		return createStaticRuntimeHost(staticRuntime, options)
	},
})
```

The helper installs static HMR by default, starts the host, forwards `/__pluxel/*` and document
navigations to `host.ctx.http.fetch(...)`, and stops the host when the Vite server closes.

## Packaging

`@pluxel/runtime-dev` is a private workspace package and is inlined into this package's HMR chunk.
Published output must not import `@pluxel/runtime-dev`.

`@pluxel/rolldown` remains external because it owns the complex Rolldown/OXC/Vite and web Module
Federation toolchain helpers.

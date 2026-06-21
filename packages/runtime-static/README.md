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

It does not scan workspaces, install packages, run the dynamic module adapter, or execute changed
plugin source files directly. Those are dynamic route responsibilities.

## Development UI Remotes

For development hosts that want source UI remotes:

```ts
import { createStaticRuntimeHost } from '@pluxel/runtime-static'
import { installStaticRuntimeHmr } from '@pluxel/runtime-static/hmr'
import { staticRuntimeVitePlugins } from '@pluxel/runtime-static/vite'
```

Use `staticRuntimeVitePlugins(...)` in the host Vite config. In dev, disable
`runtimeUiBridge` when the host installs runtime source handles; enable it for packaged/static
production builds.

After creating a host, call `installStaticRuntimeHmr({ host, viteServer })` before `host.start()`.
This installs only route-neutral source UI handling. Catalog reload remains static-owned and should
still happen through `reloadStaticRuntime(...)`.

## Packaging

`@pluxel/runtime-dev` is a private workspace package and is inlined into this package's HMR chunk.
Published output must not import `@pluxel/runtime-dev`.

`@pluxel/rolldown` remains external because it owns the complex Rolldown/OXC/Vite and web Module
Federation toolchain helpers.

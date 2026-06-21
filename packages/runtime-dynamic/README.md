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

It reuses the private `@pluxel/runtime-dev` source UI compiler by inlining it at build time. That
keeps source UI remote behavior aligned with static while leaving the dynamic loader model local to
this package.

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

# Plugins Host Samples

> Status: internal workspace app (examples + smoke). Not part of the published package set.

`projects/plugin-host` keeps runnable samples for the dynamic and static runtime routes.

Recommended entries:

- `dynamic`: host-owned Vite server with `@pluxel/runtime-dynamic/vite`
- `static`: host-owned Vite server with `@pluxel/runtime-static/vite`

The dynamic Vite config is [vite.dynamic.config.ts](./vite.dynamic.config.ts). The route config is
[src/pluxel.dynamic.ts](./src/pluxel.dynamic.ts).
The static Vite config is [vite.static.config.ts](./vite.static.config.ts). The static runtime
config is [src/pluxel.static.ts](./src/pluxel.static.ts).

## Run

dynamic HMR:

```sh
pnpm plugin-host:dynamic
pnpm --filter @pluxel/plugins-host dynamic
```

static fixed catalog:

```sh
pnpm plugin-host:static
pnpm --filter @pluxel/plugins-host static
```

## Loader HMR Tools

```sh
pnpm --filter @pluxel/plugins-host dynamic:prompt
pnpm --filter @pluxel/plugins-host dynamic:doctor
```

## Boundary

- Dynamic uses a host-owned Vite server and wires loader HMR through `dynamicRuntimeVitePlugin`.
- Static uses a host-owned Vite server and wires the fixed catalog through `staticRuntimeVitePlugin`.
- Plugin source is always evaluated by the Pluxel Vite/Rolldown transform chain; raw TypeScript
  runners are intentionally not runtime entries.

The host proves that the same plugin API can run under dynamic HMR and static fixed-catalog
semantics.

Capability-specific demos that need local state, such as `PluginVaultDemo`, stay in `src/demo` for
discovery/manual enablement but are not part of the default enabled set.

# Plugins Host Samples

> Status: internal workspace app (examples + smoke). Not part of the published package set.

`packages/plugins/host` keeps runnable samples for the dynamic and static runtime routes.

Recommended entries:

- `dynamic`: host-owned Vite server with `@pluxel/runtime-dynamic/vite`
- `static`: host-owned Vite server with `@pluxel/runtime-static/vite`
- `static:direct`: headless fixed-catalog host with `createStaticRuntime`

The dynamic Vite config is [vite.dynamic.config.ts](./vite.dynamic.config.ts). The route config is
[src/pluxel.dynamic.ts](./src/pluxel.dynamic.ts).
The static Vite config is [vite.static.config.ts](./vite.static.config.ts). The static runtime
config is [src/pluxel.static.ts](./src/pluxel.static.ts); the direct Node host entry
[src/static.ts](./src/static.ts) imports that config directly and only owns platform startup.

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

static direct launcher:

```sh
pnpm plugin-host:static:direct
pnpm --filter @pluxel/plugins-host static:direct
```

## Loader HMR Tools

```sh
pnpm --filter @pluxel/plugins-host dynamic:prompt
pnpm --filter @pluxel/plugins-host dynamic:doctor
```

## Boundary

- Dynamic uses a host-owned Vite server and wires loader HMR through `dynamicRuntimeVitePlugin`.
- Static uses a host-owned Vite server and wires the fixed catalog through `staticRuntimeVitePlugin`.
- Static direct mode uses `createStaticRuntime(config)` with the same complete runtime config from
  [src/pluxel.static.ts](./src/pluxel.static.ts).

The host proves that the same plugin API can run under dynamic HMR and static fixed-catalog
semantics.

Capability-specific demos that need local state, such as `PluginVaultDemo`, stay in `src/demo` for
discovery/manual enablement but are not part of the default enabled set.

Authelia/OIDC setup lives in `packages/plugins/authelia-oidc-demo`. Keep that integration separate
from this general-purpose host package.

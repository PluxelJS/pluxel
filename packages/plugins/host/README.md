# Plugins Host Samples

> Status: internal workspace app (examples + smoke). Not part of the published package set.

`packages/plugins/host` keeps runnable samples for the dynamic and static runtime routes.

Recommended entries:

- `dynamic`: host-owned Vite server with `@pluxel/runtime-dynamic/vite`
- `static`: headless fixed-catalog host with `@pluxel/runtime-static`

The dynamic Vite config is [vite.dynamic.config.ts](./vite.dynamic.config.ts). The route config is
[src/pluxel.dynamic.ts](./src/pluxel.dynamic.ts).
The static runtime config is [src/pluxel.static.ts](./src/pluxel.static.ts); the Node host entry
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

## Loader HMR Tools

```sh
pnpm --filter @pluxel/plugins-host dynamic:prompt
pnpm --filter @pluxel/plugins-host dynamic:doctor
```

## Boundary

- Dynamic uses a host-owned Vite server and wires loader HMR through `dynamicRuntimeVitePlugin`.
- Static headless mode uses `createStaticRuntime(config)` with the same complete runtime config from
  [src/pluxel.static.ts](./src/pluxel.static.ts).

The host proves that the same plugin API can run under dynamic HMR and static fixed-catalog
semantics.

Capability-specific demos that need external setup, such as `PluginVaultDemo` and
`PluginAutheliaOidcDemo`, stay in `src/demo` for discovery/manual enablement but are not part of the
default enabled set.

Authelia/OIDC setup files live in [authelia-demo](./authelia-demo). That demo intentionally separates
Pluxel host verification from a plugin-owned business OIDC login.

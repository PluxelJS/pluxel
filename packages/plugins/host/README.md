# Plugins Host Samples

> Status: internal workspace app (examples + smoke). Not part of the published package set.

`packages/plugins/host` keeps runnable samples for the dynamic and static runtime routes.

Recommended entries:

- `dynamic`: host-owned Vite server with `@pluxel/runtime-dynamic/vite`
- `static`: headless fixed-catalog host with `@pluxel/runtime-static`

The dynamic Vite config is [vite.dynamic.config.ts](./vite.dynamic.config.ts). The route config is
[src/pluxel.dynamic.ts](./src/pluxel.dynamic.ts).

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
- Static headless mode uses `createStaticRuntimeHost()` with the catalog from
  [src/pluxel.static.ts](./src/pluxel.static.ts).
- Static Vite mode should use `staticRuntimeVitePlugin({ config })`.

The host proves that the same plugin API can run under dynamic HMR and static fixed-catalog
semantics.

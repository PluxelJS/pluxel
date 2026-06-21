# @pluxel/rolldown

Pluxel toolchain package for build helpers, Rolldown plugins, Vite adapters, workspace utilities, web Module Federation UI builds, and the repository oxlint plugin.

Use the narrowest subpath that matches the job:

- `@pluxel/rolldown/build`: tsdown/build runner helpers used by `pluxel build`.
- `@pluxel/rolldown/plugins`: Rolldown-first plugins such as `runtimeUiBridgePlugin`, `configSourcePlugin`, and `lintGuardPlugin`.
- `@pluxel/rolldown/vite`: Vite-facing helpers. These are Rolldown/toolchain utilities plus Vite-specific fields where Vite needs them.
- `@pluxel/rolldown/vite/environment`: Vite environment filters such as `serverOnlyVitePlugin(...)` and `browserOnlyVitePlugin(...)`.
- `@pluxel/rolldown/vite/plugin-ui`: plugin UI remote build helper used by static/dynamic development routes through their inlined `runtime-dev` glue.
- `@pluxel/rolldown/workspace/fs`, `@pluxel/rolldown/workspace/info`, `@pluxel/rolldown/workspace/vite`: workspace helpers. Prefer explicit subpaths over `@pluxel/rolldown/workspace`.
- `@pluxel/rolldown/oxlint`: Pluxel oxlint JS plugin.

Runtime routes own HMR commit semantics. `@pluxel/rolldown` only provides route-neutral toolchain pieces:

- dynamic route does workspace scan, loader/module replacement, and dynamic commit tracking
- static route does static definition import and catalog diff
- private `@pluxel/runtime-dev` wires source UI declarations to `@pluxel/rolldown/vite/plugin-ui`

Do not inline native toolchain packages such as OXC parser/resolver or Rolldown bindings into route packages. Published consumers that need complex toolchain behavior should depend on `@pluxel/rolldown` and externalize its subpaths in their own tsdown configs.

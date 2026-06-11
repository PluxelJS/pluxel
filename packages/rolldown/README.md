# @pluxel/rolldown

Pluxel toolchain package for build helpers, Rolldown plugins, Vite adapters, workspace utilities, and the repository oxlint plugin.

Use the narrowest subpath that matches the job:

- `@pluxel/rolldown/build`: tsdown/build runner helpers used by `pluxel build`.
- `@pluxel/rolldown/plugins`: Rolldown-first plugins such as `runtimeUiBridgePlugin`, `configSourcePlugin`, and `lintGuardPlugin`.
- `@pluxel/rolldown/vite`: Vite-facing helpers. These are Rolldown/toolchain utilities plus Vite-specific fields where Vite needs them.
- `@pluxel/rolldown/vite/environment`: Vite environment filters such as `serverOnlyVitePlugin(...)` and `browserOnlyVitePlugin(...)`.
- `@pluxel/rolldown/vite/plugin-ui`: plugin UI remote build helper shared by dynamic/static HMR routes.
- `@pluxel/rolldown/workspace/fs`, `@pluxel/rolldown/workspace/info`, `@pluxel/rolldown/workspace/vite`: workspace helpers. Prefer explicit subpaths over `@pluxel/rolldown/workspace`.
- `@pluxel/rolldown/oxlint`: Pluxel oxlint JS plugin.

Runtime routes own HMR commit semantics. `@pluxel/rolldown` only provides the route-neutral toolchain pieces: dynamic route still does loader/module replacement, static route does definition import and catalog diff.

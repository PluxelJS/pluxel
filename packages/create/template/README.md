# Pluxel example workspace

This is a fixed, neutral example workspace for learning Pluxel plugin development. The project name,
package names and class names are intentionally not generated: rename them only when the example has
become your own application.

Start with the [current upstream Pluxel documentation](https://github.com/PluxelJS/pluxel/blob/main/docs/index.md),
or print a focused link with `pnpm exec pluxel docs development/testing.md`, then run:

```sh
pnpm dev
```

The host declares its fixed Plugin catalog and optional mutable sources in `host/src/app.ts`.
Vite development and production builds consume that same `HostApplication` declaration.
Its `configure()` returns an explicit service list; `standardServices()` supplies the common server services,
with Logging, Vault, Management and Workbench added by the application. `host/web/` is an independent private workspace package
for browser-only React source and frontend dependencies; `host/` owns the Vite and Pluxel application
configuration, installs the workspace Plugins and serves the page and Plugin routes on
the stable Portless application origin printed at startup.

The root installs `pncat` as the only catalog-management interface. Versions are grouped by
`pncat.config.ts`; use `pnpm catalog:add -- <package>`, `pnpm catalog:migrate`, and
`pnpm catalog:clean` instead of editing catalog entries or package references by hand. Packages still
declare every dependency they directly use: the root centralizes version policy, not dependency ownership.
The governance check rejects bare third-party version specifiers, so every external version remains visible
in one named catalog while internal workspace and peer edges retain their package-owned contracts.
The starter policy already recognizes common React UI, testing, backend/data and build-tool ecosystems;
extend the rules in `pncat.config.ts` when the product adopts a new dependency family.

The host package build runs its one Vite config first, then [`host/tsdown.config.ts`](host/tsdown.config.ts)
uses `pluxel()` and copies `host/web/dist` into `host/dist/public`. The host finally runs
`pluxel distribution create` after that write so the distribution manifest covers browser assets.

Workbench is enabled by default. It shares the Vite process but owns the non-root
`https://<workspace-directory>.localhost/__pluxel/workbench` path, leaving the product SPA at
`https://<workspace-directory>.localhost/`. Both URLs use one origin and one Vite listener. Set
`PLUXEL_WORKBENCH=false` when the host should run without the management UI.

```sh
PLUXEL_WORKBENCH=false pnpm dev
```

The listener Portless allocates is an implementation detail. To bypass the named development ingress,
run `pnpm dev:direct` or `PORTLESS=0 pnpm dev`.

The application also declares `.pluxel/managed-plugins/*.mjs` as a mutable source, relative to the
process working directory. `PLUXEL_DATA_ROOT` overrides the `.pluxel` directory for both
mutable sources and persistence. Keep it outside the immutable `host/dist` distribution;
use an absolute path in deployment. Publish built ESM Plugin entries there to make them available in the same
catalog; availability does not automatically start a Plugin. Remove `sources` from `host/src/app.ts`
when the application only needs its fixed imports. No Vite mode or second configuration is required.

## What the example demonstrates

- `packages/domain` provides framework-neutral Todo value rules with ordinary Vitest tests.
- `plugins/todo` owns Todo state and one exported Valibot config schema. The host reuses that
  schema to validate the `EXAMPLE_TODO_MAX_ITEMS` first-start seed read by `configure()`.
  Add application-specific environment variables to your deployment configuration explicitly.
- `plugins/http` declares `TodoPlugin` as a required constructor dependency and validates HTTP input.
- `plugins/todo` observes `AuditPlugin` through `definePluginRef()` as an optional integration.
- Plugin tests use the Pluxel Vitest preset and the smallest matching core/runtime test host.
- `host/web` is the `@example/web` workspace package and declares its frontend-only dependencies.
- `host/vite.config.ts` serves that source and lets generation-scoped Elysia routes claim `/api` before SPA fallback.
- `host` records `@example/web` as a build input, installs the workspace Plugins and owns one application declaration for development and production.

Open the `Application` URL printed by `pnpm dev`. The Todo UI calls the same-origin Plugin-owned
`/api/example/todos` routes to list, create, complete and remove items.

## Verify the complete workspace

```sh
pnpm verify
```

This runs governance checks, formatting, Pluxel Oxlint rules, type checking, tests and the production
application build. To create a real publishable plugin package alongside the examples, use:

```sh
pluxel new --name @your-scope/your-plugin plugins
```

# Pluxel example workspace

This is a fixed, neutral example workspace for learning Pluxel plugin development. The project name,
package names and class names are intentionally not generated: rename them only when the example has
become your own application.

Start with the versioned documentation copied into [`docs/pluxel/`](docs/pluxel/README.md), then run:

```sh
pnpm dev
```

The default host is static. It imports an auditable fixed catalog and uses the same canonical entry for
Vite development and the production freezer. `host/web/` is an independent private workspace package
for browser-only React source and frontend dependencies; `host/` owns the Vite and Pluxel application
configuration, installs the workspace Plugins and serves the page and Plugin routes on
`http://127.0.0.1:3310`.

The root installs `pncat` as the only catalog-management interface. Versions are grouped by
`pncat.config.ts`; use `pnpm catalog:add -- <package>`, `pnpm catalog:migrate`, and
`pnpm catalog:clean` instead of editing catalog entries or package references by hand. Packages still
declare every dependency they directly use: the root centralizes version policy, not dependency ownership.

The host package build runs its one Vite config first, then [`host/tsdown.config.ts`](host/tsdown.config.ts)
uses `staticApplication()` and copies `host/web/dist` into `host/dist/public`. The host finally runs
`pluxel distribution create` after that write so the distribution manifest covers browser assets.

Set `PLUXEL_WORKBENCH=true` when you want the Workbench UI. It shares the Vite process but owns the
non-root `http://127.0.0.1:3310/__pluxel/workbench` path, leaving the product SPA at `/`.

```sh
PLUXEL_WORKBENCH=true pnpm dev
```

The repository also includes a dynamic host configuration:

```sh
pnpm dev:dynamic
```

Both modes use the same Plugin classes and runtime state. Dynamic mode additionally watches
`.pluxel/managed-plugins/*.mjs` as mutable source entries.

## What the example demonstrates

- `packages/domain` provides framework-neutral Todo value rules with ordinary Vitest tests.
- `plugins/todo` owns Todo state and one Valibot config schema.
- `plugins/http` declares `TodoPlugin` as a required constructor dependency and validates HTTP input.
- `plugins/todo` observes `AuditPlugin` through `definePluginRef()` as an optional integration.
- Plugin tests use the Pluxel Vitest preset and the smallest matching core/runtime test host.
- `host/web` is the `@example/web` workspace package and declares its frontend-only dependencies.
- `host/vite.config.ts` serves that source and lets Plugin-mounted routes claim `/api` before SPA fallback.
- `host` records `@example/web` as a build input, installs the workspace Plugins and switches static/dynamic route policy by Vite mode.

Open `http://127.0.0.1:3310` after `pnpm dev`. The Todo UI calls the same-origin Plugin-owned
`/api/example/todos` routes to list, create, complete and remove items.

## Verify the complete workspace

```sh
pnpm verify
```

This runs governance checks, formatting, Pluxel Oxlint rules, type checking, tests and the frozen static
application build. To create a real publishable plugin package alongside the examples, use:

```sh
pluxel new --name @your-scope/your-plugin plugins
```

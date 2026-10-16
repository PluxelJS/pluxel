# Pluxel example workspace

This is a fixed, neutral example workspace for learning Pluxel plugin development. The project name,
package names and class names are intentionally not generated: rename them only when the example has
become your own application.

Coding agents: read [AGENTS.md](./AGENTS.md), then use the
[pluxel-development skill](.agents/skills/pluxel-development/SKILL.md), available after workspace setup.
The skill routes development, service diagnostics and live operations to the relevant tools and documentation.

Start with the [current upstream Pluxel documentation](https://github.com/PluxelJS/pluxel/blob/main/docs/index.md),
or find source inspection, live operations and tests with `vp exec pluxel docs development/index.md`, then run:

```sh
mise trust
mise install
vp install
vp run setup
# In an initialized Git repository:
vp run hooks:install
vp run dev
```

The host declares its fixed Plugin catalog and optional sources in `host/src/app.ts`.
Vite development and production execution consume that same `defineHostApplication(factory)` declaration.
The application factory returns an explicit service list; `servicesPreset()` from `@pluxel/services/preset` combines base services,
Logging, Vault, Management and optional Workbench. `host/web/` is an independent private workspace package
for browser-only React source and frontend dependencies; `host/` owns the Vite and Pluxel application
configuration, installs the workspace Plugins and serves the page and Plugin routes on
the application origin reported by Pitchfork. See the [workspace guide](https://github.com/PluxelJS/pluxel/blob/main/docs/development/workspace-toolchain.md) for tool setup, proxy configuration and agent workflows.

The CLI bundles pncat; use `pluxel pncat` without installing a separate `pncat` dependency.
Configuration helpers come from `@pluxel/cli/pncat`. Versions are grouped by
`pncat.config.ts`; use `vp exec pluxel pncat add <package>` to add dependencies, `vp exec pluxel pncat migrate`
to migrate declarations, `vp exec pluxel workspace sync` to align existing catalog versions, and `vp exec pluxel pncat clean`
to remove unused entries. Sync never changes package manifests. Packages still
declare every dependency they directly use: the root centralizes version policy, not dependency ownership.
The governance check rejects bare third-party version specifiers, so every external version remains visible
in one named catalog while internal workspace and peer edges retain their package-owned contracts.
The starter policy already recognizes common React UI, testing, backend/data and build-tool ecosystems;
extend the rules in `pncat.config.ts` when the product adopts a new dependency family.

Vite Task runs each package build through its standard `build` script and native `compile` task, preserving dependency order and build outputs.
The host first builds its web assets, then `vp pack` reads the `pack` block from `host/vite.config.ts`.
That block imports [`host/tsdown.config.ts`](host/tsdown.config.ts), which uses `pluxel({ delivery: 'modules' })` from `@pluxel/rolldown` and copies
`host/web/dist` into `host/dist/public`. The host finally runs
`pluxel distribution create` after that write so the distribution manifest covers browser assets.

Workbench is enabled by default at `/__pluxel/workbench`, alongside the product SPA at `/`.
Both use one origin and one Vite listener. `pitchfork.toml` manages the `app` service,
assigns its internal port and waits for readiness. The project's HTTP proxy configuration
uses one shared public port, `8088`, with URLs such as `http://app.<workspace-directory>.localhost:8088`.
Starting the service also starts the supervisor when needed. No user config, certificates, sudo,
DNS setup or hosts changes are required for browsers that resolve `.localhost`. Existing supervisors
keep their startup settings; see the workspace guide before restarting a shared supervisor.

Use `pitchfork status app`, `pitchfork logs app`, `pitchfork restart app` and
`pitchfork stop app` to inspect and manage the service. Vite owns source hot reload;
Pitchfork owns process lifetime. Set `PLUXEL_WORKBENCH=false` in `pitchfork.local.toml`
under `[daemons.app.env]` and restart `app` to disable Workbench locally.
For foreground debugging, run `vp run @example/host#dev:server`.

`mise.toml` pins Node, pnpm, Vite+, hk and Pitchfork. `hk.pkl` owns changed-file linting and
formatting (`hk check` / `hk fix`); install its Git hooks explicitly after
`git init`. Full workspace checks remain `vp run verify`, also used in CI.

The application declares `.pluxel/managed-plugins/entries/*.mjs` as a source. `PLUXEL_DATA_ROOT`
selects the data directory relative to the execution root; development uses `host/web`, while both
production launchers use `host`. Set the same absolute path to share data between them, and keep it outside `host/dist`.
Publish precompiled ESM there to make Plugins available in the catalog; availability does not start them.
The declaration validates and freezes data. Native startup accepts one snapshot; Vite owns live observation.

`vp run build` emits modules delivery: `host/dist/app.mjs` exports the factory and product, package dependencies
remain installed, and each example Plugin builds its public `dist/index.mjs` before the host. Local
Plugin/Node/Workbench artifacts are compiled. `vp run @example/host#start`
runs `host/start.mjs` in native Node and serves the compiled SPA and Workbench Shell. Publish sources before
starting a fresh process to accept their new versions. The launcher binds before evaluating business imports;
do not preload the application or its dependency graph. The host declares every package in the official
shared list directly so binding does not depend on workspace hoisting.

For continuous production updates, run `vp run @example/host#start:vite` after building. The independent
`host/vite.runtime.config.ts` loads the same compiled factory; `host/start-vite.mjs` owns the production session
and closes it on shutdown. It serves compiled assets and business HTTP/WebSocket without a development
console or browser Vite middleware. For a deployment that omits development dependencies, first declare
its execution tools as runtime dependencies with `cd host && vp exec pluxel pncat add @pluxel/host-vite vite`.
Native deployment keeps these tools in development dependencies. Development continues to use `host/vite.config.ts` and the source factory.

## What the example demonstrates

- `packages/domain` provides framework-neutral Todo value rules with ordinary Vitest tests.
- `plugins/todo` owns Todo state and one exported Valibot config schema. The host reuses that
  schema to validate the `EXAMPLE_TODO_MAX_ITEMS` first-start seed read by the application factory.
  Add application-specific environment variables to your deployment configuration explicitly.
- `plugins/http` declares `TodoPlugin` as a required constructor dependency and validates HTTP input.
- `plugins/todo` observes `AuditPlugin` through `definePluginRef()` as an optional integration.
- Plugin tests use the Pluxel Vitest preset and the smallest matching core/runtime test host.
- `host/web` is the `@example/web` workspace package and declares its frontend-only dependencies.
- `host/vite.config.ts` serves that source and lets generation-scoped Elysia routes claim `/api` before SPA fallback.
- `host` records `@example/web` as a build input, installs the workspace Plugins and owns one application declaration for development and production.

Open the application URL from `pitchfork status app`. The Todo UI calls the same-origin Plugin-owned
`/api/example/todos` routes to list, create, complete and remove items.

## Verify the complete workspace

```sh
vp run verify
```

This runs governance checks, formatting, Pluxel Oxlint rules, type checking, tests and the production
application build. To create a real publishable plugin package alongside the examples, use:

```sh
pluxel new --name @your-scope/your-plugin plugins
```

# Repository instructions for coding agents

Before changing files under `plugins/`, plugin-facing contracts, Pluxel host configuration, or
`oxlint.config.ts`, start with `pnpm exec pluxel docs` and follow the canonical upstream user
documentation. Keep product-specific notes here; do not copy or fork Pluxel API guidance locally.

Keep these boundaries intact:

- required plugin dependencies belong in the consuming Plugin or PluginPart constructor; optional integrations use a non-exported
  module-level `definePluginRef<T>()` and a direct `plugins.use(ref, setup)` statement in `init()`;
- each Plugin and PluginPart class declares at most one complete object schema with
  `configs.use(schema)`; owner-contained resources use static field-owned `parts.use(PartClass)` composition,
  and Part requirements are lifted to the owning Plugin without being repeated there;
- use Part `ctx`, `host`, `parts`, `plugins`, and `configs`, plus Plugin `parts`, `plugins`, and `configs`,
  only inside the declaring subclass; `BasePlugin.ctx` remains public;
- keep Part fields private by default and expose explicit business methods instead of Context, root-owner, or path accessors;
- return generation cleanup from `init()` or register resources immediately with `ctx.effects`;
- business HTTP must work with Workbench Plane disabled;
- the static host is the production authority; the dynamic Vite config is an alternative development
  route over the same authoring model;
- browser-only React/Vite code stays in `web/`; Node runtime catalog, config and route policy stay in
  `host/`; shared neutral logic stays in `packages/`;
- plugin tests use `@pluxel/test/vitest` and the smallest matching core/runtime test host;
- run `pnpm verify` after changes and do not bypass Pluxel lint rules without a documented reason.

## Live development operations

For operations on an already running Pluxel Vite host, coding agents must use `pluxel dev` and
`@pluxel/runtime/dev`. Read `pnpm exec pluxel docs development/dev-console.md` first. Discover the
host and keep its absolute `--root` and exact `--instance` on every run/result/cancel command.
Use ordinary TS module exports for config edits, Plugin methods, Workbench RPC, data and logs;
keep isolated regression tests on the test host. Enable `devConsole: true` in the host's Vite
integration when needed; do not create another runtime or reopen its database to inspect live state.

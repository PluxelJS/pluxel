# Repository instructions for coding agents

Before changing files under `plugins/`, plugin-facing contracts, Pluxel host configuration, or
`oxlint.config.ts`, start at `docs/pluxel/README.md`. Those files are copied verbatim from the Pluxel
user documentation shipped with `@pluxel/create`; do not fork their API guidance locally.

Keep these boundaries intact:

- required plugin dependencies belong in constructors; optional integrations use a non-exported
  module-level `definePluginRef<T>()` and a direct `plugins.use(ref, setup)` statement in `init()`;
- each plugin declares at most one complete object schema with `configs.use(schema)`;
- return generation cleanup from `init()` or register resources immediately with `ctx.effects`;
- business HTTP must work with Workbench Plane disabled;
- the static host is the production authority; the dynamic Vite config is an alternative development
  route over the same authoring model;
- browser-only React/Vite code stays in `web/`; Node runtime catalog, config and route policy stay in
  `host/`; shared neutral logic stays in `packages/`;
- plugin tests use `@pluxel/test/vitest` and the smallest matching core/runtime test host;
- run `pnpm verify` after changes and do not bypass Pluxel lint rules without a documented reason.

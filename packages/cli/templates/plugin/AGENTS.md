# Repository instructions for coding agents

Before changing plugin code, public contracts, package metadata, `tsdown.config.ts`, or
`oxlint.config.ts`, start at `docs/pluxel/README.md`. Those files are copied verbatim from the Pluxel
user documentation shipped with the CLI; do not fork their API guidance locally.

Keep these boundaries intact:

- required plugin dependencies belong in constructors; host-managed optional integrations use
  `plugins.use(Token)`; package-optional implementations use module-level `optionalPlugin()` refs;
- `tsdown.config.ts` only describes package input/output; `pluxel build` owns compiler semantics and
  generated plugin dependency metadata;
- business HTTP and core lifecycle must work with Workbench Plane disabled;
- plugin tests use `@pluxel/test/vitest` and the smallest matching core/runtime test host;
- run `pnpm verify` after changes and do not bypass Pluxel lint rules without a documented reason.

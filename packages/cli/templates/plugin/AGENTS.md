# Repository instructions for coding agents

Before changing plugin code, public contracts, package metadata, `tsdown.config.ts`, or
`oxlint.config.ts`, consult the documentation for the installed Pluxel version. Keep local notes
focused on this package instead of forking Pluxel's API guidance.

Run `pnpm exec pluxel docs` to print the canonical upstream documentation entry.

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
- `tsdown.config.ts` only describes package input/output; `pluxel build` owns compiler semantics and
  generated plugin dependency metadata;
- business HTTP and core lifecycle must work with Workbench Plane disabled;
- plugin tests use `@pluxel/test/vitest` and the smallest matching core/runtime test host;
- run `pnpm verify` after changes and do not bypass Pluxel lint rules without a documented reason.

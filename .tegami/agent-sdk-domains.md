---
packages:
  '@pluxel/agent-sdk': minor
  '@pluxel/host': major
  '@pluxel/rolldown': major
  '@pluxel/host-vite': major
  '@pluxel/cli': patch
  '@pluxel/create': patch
---

# Publish explicit Host and source domains for agents

Use `@pluxel/agent-sdk/host` for Script/SDK types and `createScriptScope` on an existing Host. Use `@pluxel/agent-sdk/source` for ordinary `inspectPlugin`, `listPlugins`, `inspectFile` and `inspectProject` calls from Node. Source functions require an explicit `root`, accept application resolution and cancellation, and settle their own file IO without a query session.

Remove `sdk.inspect`, Host inspection-backend injection, `openProject` and the former Host/Rolldown author entries. Executor, transport and compiler implementation exports are internal. The two public entries share canonical definition identity while keeping their runtime dependencies separate.

Application source discovery follows statically named imports within declared source spaces, including applications without package exports. Dynamic imports preserve gaps; returned definitions feed direct inspection and file ownership queries. This describes the selected source graph rather than the runtime Host catalog.

Templates ship a plain `node dev/inspect.mjs` example. CLI instructions, development guidance, script compilation consumers and public type checks use the new package.

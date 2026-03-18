# @pluxel/cli — Implementation Index (for LLM)

仓库级约束与设计目标见：

- `docs/ARCHITECTURE.md`
- `docs/PACKAGING.md`
- `docs/AGENT_RULES.md`

## Public Surface (package exports)

- `packages/cli/package.json`
  - `pluxel` bin → `packages/cli/bin/pluxel.mjs`
  - `./hmr` → `packages/cli/src/hmr/index.ts`
  - `./build` → `packages/cli/src/build.ts`
  - `./rolldown` → `packages/cli/src/rolldown.ts`

## Command Entry

- `packages/cli/src/cli.ts`
  - root command wiring + subcommands


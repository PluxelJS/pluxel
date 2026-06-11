# @pluxel/cli — Implementation Index

仓库级约束与设计目标见：

- `docs/OPS.md`
- `docs/TOOLCHAIN.md`
- `docs/GOVERNANCE.md`
- `docs/proposals/README.md`

如果你在追“命令是怎么把 runtime / loader HMR / build 串起来的”，优先看 `Command Entry`，再看各 subpath export。

## Public Surface (package exports)

- `packages/cli/package.json`
  - `pluxel` bin → `packages/cli/bin/pluxel.mjs`
  - `./hmr` → `packages/cli/src/hmr/index.ts`
  - `./build` → `packages/cli/src/build.ts`
  - `./rolldown` → `packages/cli/src/rolldown.ts`

## Command Entry

- `packages/cli/src/cli.ts`
  root command wiring + subcommands

## Command Roles

- `pluxel hmr`
  把 `@pluxel/runtime/hmr` host 作为标准开发入口暴露出来
- `pluxel build`
  把 `@pluxel/build` overlay 与相关构建 helper 串成标准构建命令
- `pluxel new`
  脚手架入口

## Relevant Exports

- `packages/cli/src/hmr/index.ts`
  `pluxel hmr` 相关能力入口
- `packages/cli/src/build.ts`
  `pluxel build` 相关能力入口
- `packages/cli/src/rolldown.ts`
  对构建 overlay / plugin wiring 的再导出

如果你在追“插件前端 build 是怎么被默认带上的”，优先读：

1. `packages/cli/src/build.ts`
2. `packages/build/src/cli.ts`
3. `packages/build/src/rolldown/plugins/runtimeUiBridgePlugin.ts`

如果你在追“开发宿主是怎么被启动的”，优先读：

1. `packages/cli/src/hmr/index.ts`
2. `packages/runtime-dynamic/src/hmr.ts`

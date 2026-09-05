# @pluxel/cli — Implementation Index

## Public surface

- `packages/cli/bin/pluxel.mjs`：唯一命令入口。
- `packages/cli/package.json`：只导出 `./package.json`，不转发 runtime、HMR 或 build API。

需要 library API 时直接使用领域包：

- build / Rolldown plugin：`@pluxel/rolldown/build`、`@pluxel/rolldown/plugins`；
- loader HMR diagnostics：`@pluxel/runtime-dynamic/hmr/diagnose`；
- dynamic runtime engine：`@pluxel/runtime-dynamic/hmr`。

## Command loading

- `src/cli.ts`：root wiring，只静态加载命令 manifest。
- `src/command-manifest.ts`：帮助文本、参数和 lazy command 映射。
- `src/commands/`、`src/scaffold/`：仅在对应命令执行时加载。

Scaffold 内部边界：

- `src/scaffold/source.ts`：区分并取得 bundled/local template root；
- `src/scaffold/contract.ts`：严格解析 `pluxel-template.jsonc`；
- `src/scaffold/prompts.ts`：收集并验证答案，不写文件；
- `src/scaffold/render.ts`：纯 `.tpl` interpolation；
- `src/scaffold/plan.ts`：编译包含最终字节和 destination preflight 的 immutable plan；
- `src/scaffold/materialize.ts`：只写 plan 已授权的 outputs；
- `src/scaffold/index.ts`：Gunshi/Clack command、安装和用户诊断。

这些模块没有 package export，也不是第三方 generator API。

CLI scaffold 只有 Plugin package identity 和 bundled `plugin` template。完整 example workspace 与固定 starter
归 `@pluxel/create`；上游文档由 `docs` 命令定位，不复制到生成项目。

可选能力：

- `build`、`workspace` → `@pluxel/rolldown`；
- `hmr` → `@pluxel/runtime-dynamic/hmr/diagnose`；
- publish market webhook → `@pluxel/market`。

缺少可选能力只影响对应命令；`--help` 和 `new` 保持可用。

## Ownership

- CLI：参数解析、交互、输出和命令编排；
- Rolldown：构建 overlay、import tracking 和 workspace build helpers；
- runtime-dynamic diagnostics：HMR config、profile、workspace scan 和 snapshot；
- runtime-dynamic engine：runtime registration、module replacement 和 route lifecycle。

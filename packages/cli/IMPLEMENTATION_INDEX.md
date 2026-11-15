# @pluxel/cli — Implementation Index

## Public surface

- `packages/cli/bin/pluxel.mjs`：唯一命令入口。
- `packages/cli/package.json`：导出 `./pncat` 配置入口与 `./package.json`。

需要 library API 时直接使用领域包：

- 外部 Host 操作：`@pluxel/agent-sdk/client`；
- build / Rolldown plugin：`@pluxel/rolldown/internal/cli`（官方 CLI 协作）、`@pluxel/rolldown/vite`；

## Command loading

- `src/cli.ts`：root wiring，只静态加载命令 manifest。
- `src/command-manifest.ts`：CLI 自有领域的帮助、参数与 lazy command 映射，挂载 SDK 的 dev children。
- `src/commands/`、`src/scaffold/`：仅在对应命令执行时加载。
- `@pluxel/agent-sdk/internal/cli`：agent 命令及其终端适配，所有权与内部导出见 [Agent Workflow](../../engineering/AGENT_WORKFLOW.md#终端适配与命令挂载)。`src/commands/dev.ts` 仅保留服务启动和 status，Host 发现复用 SDK。
- `src/source/`：source checkout 扫描、package/repository DAG、machine-local pnpm overlay、诊断与有锁执行。

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
归 `@pluxel/create`；上游文档由 `docs` 命令读取；`src/workspace/setup.ts` 统一管理消费方文档、skill 与接入状态。发行资源由 `scripts/copy-development-resources.mjs` 从唯一正文生成。

可选能力：

- `build`、`workspace` → `@pluxel/rolldown`；

`publish` 直接提交市场 HTTP 通知并输出持久回执，不加载可选 market 包；npm 拥有发布与 provenance，市场拥有收录结果。

缺少可选能力只影响对应命令；`--help` 和 `new` 保持可用。

## Ownership

- CLI：唯一 executable、命令挂载、自有领域的交互与输出、服务进程管理；
- Rolldown：构建 overlay、import tracking 和 workspace build helpers；
- Host-vite：Vite 开发/生产模块求值、更新与开发控制台；Services 的开发入口组合官方服务附件。

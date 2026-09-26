# Coding agent 工作入口

## 修改前选择入口

先运行 `pnpm exec pluxel docs development/index.md`，再按任务读取。该命令链接当前上游文档，不自动匹配已安装版本；调用前核对项目所用版本的 exports、类型与行为。本地只记录产品或包的特殊约束，不复制 Pluxel API 教程。

| 任务                                 | 文档命令                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 定位 Plugin、Part、schema 与应用输入 | `pnpm exec pluxel docs development/inspection.md`                                                                 |
| 修改依赖与生命周期                   | `pnpm exec pluxel docs getting-started/plugin-model.md`                                                           |
| 修改 Part 或配置                     | `pnpm exec pluxel docs getting-started/plugin-parts.md`、`pnpm exec pluxel docs getting-started/configuration.md` |
| 设计可恢复失败                       | `pnpm exec pluxel docs api/better-result.md`；同时阅读其中的官方示例                                              |
| 验证插件行为                         | `pnpm exec pluxel docs development/testing.md`                                                                    |

## 作者边界

- required dependency 写在消费它的 Plugin/Part constructor；optional integration 使用 non-exported module-level `definePluginRef<T>()`，并在 `init()` 中直接调用 `plugins.use(ref, setup)`。
- 每个 Plugin/Part 最多声明一个 `configs.use(schema)` 完整 object schema。Part 通过静态 field-owned `parts.use(PartClass)` 组合；其依赖自动提升到 owning Plugin，不重复声明。
- Part 的 `ctx`、`host`、`parts`、`plugins`、`configs` 与 Plugin 的 `parts`、`plugins`、`configs` 只在 subclass 内使用；`BasePlugin.ctx` 保持 public。Part 字段默认 private，对外暴露业务方法，不暴露 Context、root owner 或路径。
- 资源创建后立即登记 `ctx.effects`，或从 `init()` 返回 generation cleanup。Workbench 关闭时业务能力和核心生命周期仍须可用。
- 使用原 API 名称与直接调用；只有具体命名冲突或独立行为需要时才增加 alias/wrapper。
- 插件测试使用 `@pluxel/test/vitest` 与 `@pluxel/test` 的 `createTestHost()`，显式选择 services。

## 操作现有应用

必须先读 `pnpm exec pluxel docs development/dev-console.md`，通过 `pluxel dev` 与 `@pluxel/host-dev/console` 操作现有 Vite host。
先发现实例，后续 run/result/cancel 命令固定绝对 `--root` 和准确 `--instance`。用普通 TS 导出函数操作配置、Plugin 方法、Workbench RPC、数据和日志，并检查结果、应用报告与日志。

需要时在宿主 Vite 集成启用 `devConsole: true`。不要新建 runtime 或重开数据库来推断在线状态；隔离 test host 只验证回归。

## 本包构建与检查

- 修改插件、公共契约、package metadata、`tsdown.config.ts` 或 `oxlint.config.ts` 前，按上表确认对应契约；包发布见 `pnpm exec pluxel docs development/plugin-package.md`。
- `tsdown.config.ts` 只描述包的输入输出；`pluxel build` 拥有编译语义与生成的插件依赖 metadata。
- 完成后运行 `pnpm verify`；不得无理由绕过 Pluxel lint 规则。

# 工程维护索引

Pluxel 的框架架构、实现入口与验证方法由本目录维护。应用和插件用法见 [docs](../docs/index.md)，仓库操作规则见 [AGENTS.md](../AGENTS.md)。

## 架构入口

[系统边界](PLUGIN_SYSTEM.md)串起源码声明、Host 装配、Core generation 与可选 Workbench 的执行路径；[工程原则](DESIGN_PRINCIPLES.md)维护跨领域不变量。Context 是同步能力 kernel，Core 管 Plugin graph 和生命周期，Host 管装配与运行策略，Services 提供具体能力。领域页进一步说明机制、源码和测试。

公开入口以 package 的 `exports` 为准。修改公共 API 时同时检查 [API 设计规则](../.agents/rules/library-api-design.md)与真实调用方；依赖、导出和 workspace 调整由 [Governance](GOVERNANCE.md)维护。

## 按领域定位

| 修改对象                              | 工程文档                                                                                                                   | 源码起点                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Context kernel、scope、能力组合       | [Core](CORE.md#context-service-kernel)、[Context 公共参考](../docs/reference/context-hosts.md)                             | `packages/context/`、`packages/core/src/host.ts`                                                               |
| Plugin 身份、依赖、generation、Part   | [Identity](PLUGIN_IDENTITY.md)、[Core](CORE.md)、[生命周期](CORE_LIFECYCLE_SEMANTICS.md)                                   | [Core 实现索引](../packages/core/IMPLEMENTATION_INDEX.md)                                                      |
| Host 装配、catalog、运行意图与服务    | [Host](HOST.md)                                                                                                            | `packages/host/`、`packages/services/`                                                                         |
| 配置输入、revision、保存与采用        | [Config](CONFIG.md)                                                                                                        | `packages/core/src/services/config/`、`packages/host/`                                                         |
| 状态、文档、文件系统                  | [TinyBase](TINYBASE.md)、[FS](FS.md)                                                                                       | `packages/core/src/tinybase/`、`packages/core/src/fs/`                                                         |
| 数据库、日志、Commands                | [Database](DATABASE.md)、[Logging](LOGGING.md)、[Commands](COMMANDS.md)                                                    | `packages/services/src/`、`packages/core/src/logging/`、`packages/commands/`                                   |
| Plugin lowering、声明与源码查询       | [Toolchain](TOOLCHAIN.md)                                                                                                  | `packages/rolldown/`                                                                                           |
| 应用交付、Workbench / Node 制品       | [Application Build](APPLICATION_BUILD.md)、[Artifact Build](ARTIFACT_BUILD.md)、[Distribution](DISTRIBUTION.md)            | `packages/rolldown/`                                                                                           |
| CLI、脚手架、跨仓库源码协作           | [CLI Workspaces](CLI_WORKSPACES.md)                                                                                        | [CLI 索引](../packages/cli/IMPLEMENTATION_INDEX.md)、[Create 索引](../packages/create/IMPLEMENTATION_INDEX.md) |
| Vite 更新与开发控制台                 | [HMR](HMR.md)、[Dev Console](DEV_CONSOLE.md)                                                                               | `packages/host-vite/`                                                                                          |
| 脚本 SDK、执行、receipt 与控制材料    | [Agent Workflow](AGENT_WORKFLOW.md)、[Plugin Control](PLUGIN_CONTROL.md)                                                   | `packages/host/src/agent/`、`packages/agent-sdk/src/`、`packages/rolldown/src/control/`                        |
| Workbench publication、会话、renderer | [Workbench](WORKBENCH.md)                                                                                                  | `packages/workbench/`                                                                                          |
| Shell 导航、布局、视觉与目录          | [交互设计](WORKBENCH_DESIGN.md)、[Frontend](FRONTEND.md)、[Plugin Catalog](PLUGIN_CATALOG.md)、[UI Library](UI_LIBRARY.md) | `packages/workbench/shell/`、`packages/valibot-form/`                                                          |
| 测试设施与真实浏览器验证              | [Testing](TESTING.md)、[Workbench 验收](WORKBENCH_FLEXLAYOUT_VALIDATION.md)                                                | `packages/test/`、各包 tests                                                                                   |
| 仓库治理、发布、贡献接纳              | [Governance](GOVERNANCE.md)、[Releasing](RELEASING.md)、[Contribution Review](CONTRIBUTION_REVIEW.md)                      | `scripts/`、`.github/`                                                                                         |
| 文档组织与改写                        | [Documentation](DOCUMENTATION.md)                                                                                          | `docs/`、`engineering/`、package 实现索引                                                                      |

跨 Plugin 调用和缓存 service handle 的撤回行为集中在[能力生命周期矩阵](PROVIDER_WITHDRAWAL_AUDIT.md)，覆盖 admission、在途任务、replacement 和 root 资源的区别。

## 设计依据与待办

- [Records](records/README.md)保存有用的迁移盘点、部署验收与设计背景，标明时间和环境。
- [Experiments](experiments/README.md)与 [spikes](spikes/README.md)保存固定环境的能力探测；实验结论的适用范围见各自记录。
- [Proposals](proposals/README.md)只列尚未决定或尚未完成的设计。

当前机制在所属领域页维护一份，公开用法、历史证据和未来方案通过链接关联。文档职责及链接维护见 [Documentation](DOCUMENTATION.md)。

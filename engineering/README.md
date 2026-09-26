# 框架维护索引

修改 Pluxel 框架时使用本页。编写应用或插件从[用户文档](../docs/index.md)进入；定位插件声明、操作在线应用和隔离回归的选择见[开发指南](../docs/development/index.md)。

## 最短工作路径

1. 读[工程原则](DESIGN_PRINCIPLES.md)与[系统边界](PLUGIN_SYSTEM.md)，确认本次改动由哪一层拥有。
2. 在下表选择涉及的领域。沿文档的实现入口读代码、exports、测试和真实调用方；只在跨边界时追加相邻领域。
3. 改公共契约时使用 [API 设计规则](../.agents/rules/library-api-design.md)；改依赖或包入口时同时读 [Governance](GOVERNANCE.md)。
4. 在拥有该事实的页面更新约束或用法，并按领域风险验证。测试工具选择见 [TESTING](TESTING.md)。

## 按改动定位

每行列出候选入口，不要求整行通读；选本次修改涉及的章节。只改 Context kernel 时先读其公共契约，涉及 Plugin generation 或 Host 服务装配时才追加 Core 或 Host。

“源码范围”用于开始搜索，不代表完整影响范围。公开入口以各 package 的 `package.json` exports 为准。

| 改动                                    | 当前约束                                                                                 | 源码范围                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Context kernel、scope、能力组合         | [Context 公共契约](../docs/reference/context-hosts.md)、[Host](HOST.md)、[Core](CORE.md) | `packages/context/`、`packages/core/src/host.ts`                                                               |
| Plugin 身份、依赖图、generation 与清理  | [身份](PLUGIN_IDENTITY.md)、[Core](CORE.md)、[生命周期证据](CORE_LIFECYCLE_SEMANTICS.md) | [Core 实现索引](../packages/core/IMPLEMENTATION_INDEX.md)                                                      |
| 宿主装配、来源、运行意图与服务所有权    | [Host](HOST.md)                                                                          | `packages/host/`、`packages/services/`                                                                         |
| 配置声明、输入、revision 与保存         | [Config](CONFIG.md)                                                                      | `packages/core/src/services/config/`、`packages/host/`、`packages/services/`                                   |
| Plugin 编译与源码查询                   | [Toolchain](TOOLCHAIN.md)                                                                | `packages/rolldown/`                                                                                           |
| 静态应用构建                            | [Application Build](APPLICATION_BUILD.md)                                                | `packages/rolldown/`、`packages/services/src/build.ts`                                                         |
| Workbench / Node 制品编译               | [Artifact Build](ARTIFACT_BUILD.md)                                                      | `packages/rolldown/`                                                                                           |
| CLI、模板与跨仓库源码协作               | [CLI Workspaces](CLI_WORKSPACES.md)                                                      | [CLI 索引](../packages/cli/IMPLEMENTATION_INDEX.md)、[Create 索引](../packages/create/IMPLEMENTATION_INDEX.md) |
| Vite 更新与开发控制台                   | [HMR](HMR.md)、[Dev Console](DEV_CONSOLE.md)                                             | `packages/host-dev/`                                                                                           |
| 测试设施                                | [Testing](TESTING.md)                                                                    | `packages/test/`、各包 tests                                                                                   |
| Commands、协议载体与发布                | [Commands](COMMANDS.md)                                                                  | `packages/commands/`、`packages/services/src/commands/`                                                        |
| 数据库、日志                            | [Database](DATABASE.md)、[Logging](LOGGING.md)                                           | `packages/services/`                                                                                           |
| Workbench 发布、会话、renderer 与 Shell | [Workbench](WORKBENCH.md)、[Frontend](FRONTEND.md)                                       | `packages/workbench/`、`packages/workbench/shell/`                                                             |
| UI 组件与 Plugin catalog                | [UI Library](UI_LIBRARY.md)、[Plugin Catalog](PLUGIN_CATALOG.md)                         | `packages/valibot-form/`、`packages/workbench/`                                                                |
| 应用制品、scaffold 与发布               | [Distribution](DISTRIBUTION.md)、[Releasing](RELEASING.md)                               | `packages/rolldown/`、[Create 索引](../packages/create/IMPLEMENTATION_INDEX.md)、`scripts/`                    |

跨 Plugin 调用或 service handle 变更还要检查缓存句柄、并发、owner 撤回和已接纳工作的处理，证据入口见[服务撤回审计](PROVIDER_WITHDRAWAL_AUDIT.md)。

## 证据与背景按需读取

| 内容                                                                                                                           | 用途与限制                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| [Host 部署验证](HOST_DEPLOYMENT_VALIDATION.md)                                                                                 | 已验证环境和待验证平台；不能从一个平台推断全部平台 |
| [服务撤回审计](PROVIDER_WITHDRAWAL_AUDIT.md)                                                                                   | 生命周期与句柄行为的证据，不另定义作者 API         |
| [时空组合记录](SPATIOTEMPORAL_COMPOSABILITY_NOTES.md)                                                                          | 设计动机与 Cordis 对照                             |
| [显式 schema 实验](experiments/tsgo-plugin-inputs/README.md)、[Content Mapper 实验](experiments/tsgo-content-mapper/README.md) | 固定版本的实验结果                                 |
| [Carrier spikes](spikes/README.md)                                                                                             | 上游能力实验，不代表当前支持矩阵                   |
| [提案](proposals/README.md)                                                                                                    | 尚未落地的决定，不作为当前契约                     |

## 文档所有权

| 位置                             | 维护什么                           | 不重复什么               |
| -------------------------------- | ---------------------------------- | ------------------------ |
| `AGENTS.md`                      | 任务分流、必须遵守的工作流程       | 领域教程和完整 API 清单  |
| `.agents/rules/`                 | 通用设计默认、理由、例外与验收方法 | Pluxel 当前架构事实      |
| `engineering/` 领域页            | 内部职责、不变量、实现与验证入口   | 公开调用教程             |
| `docs/`                          | 当前公开用法、失败、资源寿命与限制 | 内部实现说明和迁移历史   |
| package README / 实现索引        | 本包职责、安装或操作、源码导航     | 第二套插件模型或领域契约 |
| proposals / experiments / spikes | 未实现方案或有范围的实验依据       | 当前功能承诺             |

改写时先明确适用任务，再写该页拥有的事实。保留关键失败、并发、取消、所有权与验证边界；减少重复，不用删除限制换取短篇幅。每个重要结论应能沿链接找到实现或验证依据。

保持已有页面路径；更改标题时检查锚点引用。新增或移动页面时检查侧栏、相对链接和生成项目的 AGENTS。已实现提案移除落地部分，旧模型由 Git 保存。

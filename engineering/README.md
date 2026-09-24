# Pluxel Engineering Docs

`engineering/` 记录框架内部约束与实现入口。开发应用或插件从[用户文档](../docs/index.md)开始；选择 inspect、devconsole 或测试见[开发工具](../docs/development/index.md)。

## 修改框架的最短阅读路径

先读 [`DESIGN_PRINCIPLES.md`](DESIGN_PRINCIPLES.md) 与 [`PLUGIN_SYSTEM.md`](PLUGIN_SYSTEM.md)，确认工程不变量和 Core、Host、Services、工具链、Workbench 的边界。随后只加载改动涉及的领域：

| 修改领域                      | 当前约束与实现入口                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Context 与服务组合            | [公开 Context host 契约](../docs/reference/context-hosts.md)、[HOST.md](HOST.md)                                                 |
| Plugin 身份、依赖图与生命周期 | [PLUGIN_IDENTITY.md](PLUGIN_IDENTITY.md)、[CORE.md](CORE.md)、[生命周期证据矩阵](CORE_LIFECYCLE_SEMANTICS.md)                    |
| 配置声明、输入与持久化        | [CONFIG.md](CONFIG.md)                                                                                                           |
| 构建、源码查询与包边界        | [TOOLCHAIN.md](TOOLCHAIN.md)                                                                                                     |
| Vite 更新与在线开发控制台     | [HMR.md](HMR.md)、[DEV_CONSOLE.md](DEV_CONSOLE.md)                                                                               |
| 测试设施与验证入口            | [TESTING.md](TESTING.md)                                                                                                         |
| 数据库与日志                  | [DATABASE.md](DATABASE.md)、[LOGGING.md](LOGGING.md)                                                                             |
| 插件 UI、Workbench 与 catalog | [FRONTEND.md](FRONTEND.md)、[WORKBENCH.md](WORKBENCH.md)、[UI_LIBRARY.md](UI_LIBRARY.md)、[PLUGIN_CATALOG.md](PLUGIN_CATALOG.md) |
| Commands 与调用载体           | [COMMANDS.md](COMMANDS.md)                                                                                                       |
| 分发与发布                    | [DISTRIBUTION.md](DISTRIBUTION.md)、[RELEASING.md](RELEASING.md)                                                                 |

涉及依赖、公开导出或仓库流程时同时读 [GOVERNANCE.md](GOVERNANCE.md)。新增或修改公开契约时读 [library API design guide](../.agents/rules/library-api-design.md)。用户用法仍维护在 `docs/`，工程文档不另建一套 API 教程。

## 按需查阅的验证与背景

- [Host 下游与部署验证](HOST_DEPLOYMENT_VALIDATION.md)：已验证能力与待验证平台。
- [服务能力撤回审计](PROVIDER_WITHDRAWAL_AUDIT.md)：cached handle、owner withdrawal 和 in-flight 边界的证据。
- [时空组合思考记录](SPATIOTEMPORAL_COMPOSABILITY_NOTES.md)：Cordis 对照与设计背景。
- 源码输入实验：[显式 schema 绑定](experiments/tsgo-plugin-inputs/README.md)、[TypeScript Content Mapper](experiments/tsgo-content-mapper/README.md)。仅记录固定版本证据。
- [Carrier spikes](spikes/README.md)：带日期的上游能力实验，不代表当前支持矩阵。
- [未落地提案](proposals/README.md)：待研究的问题，不作为当前公开契约。

## 文档维护

- `docs/` 拥有当前公开用法；`engineering/` 拥有内部不变量与实现入口；package README 只补充安装与本包操作；`.agents/rules/` 是决策指南。提案不作为当前契约，落地后删除已实现部分。
- 一个事实只在一处维护。首页与 AGENTS 只指路，工具指南负责调用、结果和限制；新增入口时删除被替代的说明，不复制教程。
- 每页先回答适用任务，再写最小用法、关键边界与验证。中文叙述，API 标识符保留英文；避免不影响用户选择的内部细节。
- 示例须对应当前公开入口，能力结论须有实现或验证依据。旧模型由 Git 保存。
- 调整结构时检查侧栏、引用和生成项目的 AGENTS；优先保留已有页面路径。

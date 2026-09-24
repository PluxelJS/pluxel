# Pluxel Engineering Docs

`engineering/` 用于修改 Pluxel 框架本身，记录当前架构、工程不变量和内部入口。
开发应用或插件的人与 coding agent 都从 [`docs/index.md`](../docs/index.md) 开始；首次创建项目看[快速开始](../docs/getting-started/index.md)。

## 先确定任务范围

| 当前任务                             | 从哪里开始                                                         |
| ------------------------------------ | ------------------------------------------------------------------ |
| 使用 Pluxel 开发业务功能             | [开发工作流程](../docs/development/index.md)，随后读取对应功能指南 |
| 定位 Plugin 源码、依赖或应用配置输入 | [inspect 源码查询](../docs/development/inspection.md)，不启动应用  |
| 检查已有 Vite 应用的配置、插件或日志 | [开发控制台](../docs/development/dev-console.md)，先发现并固定实例 |
| 修改框架的 API、行为或内部实现       | 按下方阅读路径加载通用约束和当前领域文档                           |
| 维护发布自动化                       | [发布流程](RELEASING.md)                                           |

按任务选择领域文档即可；历史提案描述探索背景，不能用来推断当前公开 API。

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
- [未落地提案](proposals/README.md)：待研究的问题，不作为当前公开契约。

## 文档职责

Core/Host/Services 契约见 [组合服务](../docs/reference/runtime-services.md) 与上方领域文档。

- `.agents/rules/`：可跨项目复用的 agent 决策规则，不作为 Pluxel 当前架构事实。
- `engineering/`：为什么这样分层、内部不变量、代码从哪里看起。
- `docs/`：用户应该写什么、如何选择 API、如何避免错误设计。
- package README：安装、入口和本包特有操作。
- `engineering/proposals/`：尚未实现的研究，不得作为当前 API 依据。

## 写作规则

- 只描述当前模型，不维护“旧 API 已删除”清单；历史由 Git 保存。
- 一个事实只有一个权威位置，其他文档链接过去而不复制长段落。
- 实现后的 proposal 必须删除或缩成仍未实现的部分。
- 文档中的示例必须能对应当前公开入口和 workspace 用法。

### 用户文档

- 每页开头先回答“它解决什么问题、什么时候使用”，再介绍实现规则；不要用内部名词堆叠代替说明。
- 中文负责叙述，英文只保留 API 标识符、专有名词和确有区分意义的框架术语。首次出现的术语要用一句话解释。
- 优先按“如何选择 → 最小用法 → 关键边界 → 失败与验证”组织内容。标题应帮助读者完成任务或作出选择。
- 对设计取舍给出可核对的实现事实，明确能力与限制，不把偏好写成未经验证的性能结论。
- 用户无需理解内部 package、helper 或构建阶段名称，除非这些内容会直接影响其代码或交付结果。

### 入口与发现

- `docs/index.md` 按任务分流，新建项目与接手已有项目都有直接入口。
- `docs/development/index.md` 拥有工具选择和开发工作流程；工具指南拥有调用方法、结果含义与限制。
- 新增开发工具时同步检查首页、development 侧栏、工具链页、Package 矩阵与 AGENTS 的可发现性；通过链接引用指南，避免复制操作协议。
- 根 AGENTS 与生成项目的 AGENTS 分别服务框架仓库与业务项目，两者都应能直接找到源码查询、在线操作和验证入口。
- 移动文档须同步引用和侧栏；按任务重组导航时优先保留已有页面路径。

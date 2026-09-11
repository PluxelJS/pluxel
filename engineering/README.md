# Pluxel Engineering Docs

`engineering/` 用于修改 Pluxel 框架本身，记录当前架构、工程不变量和内部入口。
开发应用或插件的人与 coding agent 都从 [`docs/index.md`](../docs/index.md) 开始；首次创建项目看[快速开始](../docs/getting-started/index.md)。

## 先确定任务范围

| 当前任务                             | 从哪里开始                                                         |
| ------------------------------------ | ------------------------------------------------------------------ |
| 使用 Pluxel 开发业务功能             | [用户文档的任务导航](../docs/index.md)，随后读取对应功能指南       |
| 检查已有 Vite 应用的配置、插件或日志 | [开发控制台](../docs/development/dev-console.md)，先发现并固定实例 |
| 修改框架的 API、行为或内部实现       | 按下方阅读路径加载通用约束和当前领域文档                           |
| 维护发布自动化                       | [发布流程](RELEASING.md)                                           |

按任务选择领域文档即可；历史提案描述探索背景，不能用来推断当前公开 API。

## 阅读路径

1. [`DESIGN_PRINCIPLES.md`](DESIGN_PRINCIPLES.md)：维护者和 coding agent 必须遵守的工程不变量。
2. [`PLUGIN_SYSTEM.md`](PLUGIN_SYSTEM.md)：插件、runtime、route、toolchain 和 Workbench Plane 的总边界。
3. 按改动领域阅读：
   - [`../docs/reference/context-hosts.md`](../docs/reference/context-hosts.md)：公开 Context host kernel、root/scope/owner-view 语义与 standalone host 组合边界。
   - [`PLUGIN_IDENTITY.md`](PLUGIN_IDENTITY.md)：definition/node address 与 slot、source canonicalization、reference/route/label、作用域和持久化边界。
   - [`CORE.md`](CORE.md)：slot identity、DI graph、optional restart、generation lifecycle 与 effects。
   - [`CORE_LIFECYCLE_SEMANTICS.md`](CORE_LIFECYCLE_SEMANTICS.md)：Core lifecycle 抽象状态、不变量和测试证据矩阵。
   - [`RUNTIME.md`](RUNTIME.md)：常驻服务、static/dynamic route、可选宿主能力。
   - [`PROVIDER_WITHDRAWAL_AUDIT.md`](PROVIDER_WITHDRAWAL_AUDIT.md)：owner-bound runtime capability 的 withdrawal、cached handle 和 in-flight 边界。
   - [`SPATIOTEMPORAL_COMPOSABILITY_NOTES.md`](SPATIOTEMPORAL_COMPOSABILITY_NOTES.md)：Cordis 对照后的 lifecycle、capability withdrawal、system boundary 与 compatibility 思考记录。
   - [`DATABASE.md`](DATABASE.md)：PostgreSQL/Drizzle、PGlite/PG、migration、隔离与 outbox。
   - [`LOGGING.md`](LOGGING.md)：single active root、Context identity、plugin policy、sinks 与大基数预算。
   - [`CONFIG.md`](CONFIG.md)：声明、校验、持久化和 Workbench 投影。
   - [`TESTING.md`](TESTING.md)：测试边界、Vitest preset bootstrap 与验证入口。
   - [`DEV_CONSOLE.md`](DEV_CONSOLE.md)：面向 coding agent 的在线 TypeScript 操作、Vite 更新、配置、Workbench 与日志。
   - [`FRONTEND.md`](FRONTEND.md)：插件 UI、interaction 和 workbench ownership。
   - [`UI_LIBRARY.md`](UI_LIBRARY.md)：Workbench 的 Mantine 决策、主题边界与 federated renderer Provider/CSS 规则。
   - [`TOOLCHAIN.md`](TOOLCHAIN.md)：Vite/Rolldown metadata、artifact 和 lint。
   - [`DISTRIBUTION.md`](DISTRIBUTION.md)：static artifact set、DSSE、offline verification 与 delivery marker。
   - [`HMR.md`](HMR.md)：module runner、replacement 和 watcher 边界。
   - [`WORKBENCH.md`](WORKBENCH.md)：host-owned 管理工作台。
   - [`PLUGIN_CATALOG.md`](PLUGIN_CATALOG.md)：Management Plugin catalog 依赖聚合、人工分组与独立文件。
   - [`COMMANDS.md`](COMMANDS.md)：Agent/CLI/message command kernel 与 carrier 边界。
4. [`GOVERNANCE.md`](GOVERNANCE.md)：依赖方向、导出和文档维护规则。
5. [`RELEASING.md`](RELEASING.md)：维护者工具版本、Tegami 与可信发布流程。

## 文档职责

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

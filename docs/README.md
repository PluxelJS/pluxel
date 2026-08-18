# Pluxel Maintainer Docs

`docs/` 记录当前实现的架构边界、维护不变量和内部入口。插件作者请从 [`user-docs/README.md`](../user-docs/README.md) 开始，不需要理解这里的内部 wiring。

## 阅读路径

1. [`DESIGN_PRINCIPLES.md`](DESIGN_PRINCIPLES.md)：维护者和 coding agent 必须遵守的工程不变量。
2. [`PLUGIN_SYSTEM.md`](PLUGIN_SYSTEM.md)：插件、runtime、route、toolchain 和 Workbench Plane 的总边界。
3. 按改动领域阅读：
   - [`CORE.md`](CORE.md)：slot identity、DI graph、optional restart、generation lifecycle 与 effects。
   - [`CORE_LIFECYCLE_SEMANTICS.md`](CORE_LIFECYCLE_SEMANTICS.md)：Core lifecycle 抽象状态、不变量和测试证据矩阵。
   - [`RUNTIME.md`](RUNTIME.md)：常驻服务、static/dynamic route、可选宿主能力。
   - [`PROVIDER_WITHDRAWAL_AUDIT.md`](PROVIDER_WITHDRAWAL_AUDIT.md)：owner-bound runtime capability 的 withdrawal、cached handle 和 in-flight 边界。
   - [`SPATIOTEMPORAL_COMPOSABILITY_NOTES.md`](SPATIOTEMPORAL_COMPOSABILITY_NOTES.md)：Cordis 对照后的 lifecycle、capability withdrawal、system boundary 与 compatibility 思考记录。
   - [`DATABASE.md`](DATABASE.md)：PostgreSQL/Drizzle、PGlite/PG、migration、隔离与 outbox。
   - [`LOGGING.md`](LOGGING.md)：single active root、Context identity、plugin policy、sinks 与大基数预算。
   - [`CONFIG.md`](CONFIG.md)：声明、校验、持久化和Workbench投影。
   - [`FRONTEND.md`](FRONTEND.md)：插件 UI、interaction 和 workbench ownership。
   - [`TOOLCHAIN.md`](TOOLCHAIN.md)：Vite/Rolldown metadata、artifact 和 lint。
   - [`DISTRIBUTION.md`](DISTRIBUTION.md)：static artifact set、DSSE、offline verification 与 delivery marker。
   - [`HMR.md`](HMR.md)：module runner、replacement 和 watcher 边界。
   - [`WORKBENCH.md`](WORKBENCH.md)：host-owned 管理工作台。
   - [`PLUGIN_CATALOG.md`](PLUGIN_CATALOG.md)：Workbench 插件目录分类、包默认值与用户偏好。
   - [`COMMANDS.md`](COMMANDS.md)：Agent/CLI/message command kernel 与 carrier 边界。
4. [`GOVERNANCE.md`](GOVERNANCE.md)：依赖方向、导出和文档维护规则。
5. [`RELEASING.md`](RELEASING.md)：维护者工具版本、Changesets 与可信发布流程。

## 文档职责

- `.agents/rules/`：可跨项目复用的 agent 决策规则，不作为 Pluxel 当前架构事实。
- `docs/`：为什么这样分层、内部不变量、代码从哪里看起。
- `user-docs/`：用户应该写什么、如何选择 API、如何避免错误设计。
- package README：安装、入口和本包特有操作。
- `docs/proposals/`：尚未实现的研究，不得作为当前 API 依据。

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

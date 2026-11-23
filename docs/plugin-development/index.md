---
title: 插件开发指南
description: 掌握 Pluxel 插件的核心模型、依赖注入、生命周期管理、配置与测试方法。
---

在 Pluxel 中，业务功能以插件为单元进行封装。每个插件都是一个普通的 TypeScript 类，通过框架提供的上下文（Context）和生命周期管理基础设施，能够优雅地组织依赖、处理配置、管理异步任务并进行单元测试。

## 核心机制

插件通过 Context 使用框架内建能力。移植插件时，先核对目标宿主提供的网络、存储和日志后端。 [跨平台宿主契约](../host/runtime-portability.md)

- **[依赖与拓扑](./model.md)**：通过构造函数参数直接注入必需依赖；通过 `definePluginRef` 接入可选依赖，构建清晰的拓扑图。
- **[生命周期与清理](./lifecycle.md)**：通过 `init()` 钩子启动后台任务，使用 `ctx.effects.defer()` 登记资源释放回调，确保热重载与退出时无泄漏。
- **[配置模型](./configuration.md)**：使用 Valibot Schema 统一定义配置类型、默认值、运行时校验与 Workbench 管理表单。
- **[事件通知](./events.md)**：利用 `ctx.events` 广播或订阅跨插件事件，松耦合串联业务流程。
- **[结构化日志](./logging.md)**：使用 `ctx.logger` 输出携带上下文的结构化日志，方便本地调试与运维排查。
- **[受管出站 HTTP](./outbound-http.md)**：通过 `ctx.wretch` 或 `ctx.fetch` 请求外部服务，沿用宿主的代理和出站限制。
- **插件状态与文件**　用 TinyBase 保存节点状态，用 `ctx.fs()` 读写文件。需要跨重启恢复时，在打开资源时请求持久后端。 [TinyBase](./tinybase.md) · [文件系统](./fs.md)
- **部署凭据**　用 `ctx.vault` 读取部署方注入的记录。需要在运行中修改凭据时，由宿主提供可写的加密后端。 [Vault](./vault.md)
- **[拆分内部逻辑（PluginPart）](./parts.md)**：对于逻辑庞大的插件，使用 `PluginPart` 拆分子模块与局部配置，随父插件统一启停。
- **[插件测试](./testing.md)**：借助 `@pluxel/test` 在纯内存测试宿主中进行端到端隔离验证。

## 按需扩展服务

应用按业务需要安装以下服务。

- **网络接口**：[HTTP / WebSocket](./http.md) 将路由挂载到宿主的 Elysia 引擎中。
- **指令系统**：[Commands](./commands.md) 定义控制台命令、MCP 工具或文本交互指令。
- **关系型数据**　通过宿主安装的数据库服务执行 SQL 查询与迁移。 [SQL 数据库](./database.md)
- **Node 任务与 Worker**：[Node 制品与任务](./node-artifacts.md) 执行后台工作线程与计算密集型逻辑。
- **可视化界面**：[Workbench 工作台](../workbench/index.md) 为插件定制可视化管理面板与交互视图。

## 设计建议与模式

在设计较复杂的业务交互时，建议参考以下设计模式：

- [API 契约设计](./contracts.md)：明确插件对外暴露的方法签名、参数校验与对象所有权。
- [错误处理与 Better Result](./better-result.md)：在预期失败、可恢复分支与领域错误较多的场景下优雅处理返回结果。
- [异步并发与任务控制](./async.md)：处理并发排队、合并请求（singleflight）、超时重试与取消信号。
- [上线前检查清单](./review.md)：快速核对资源释放、配置默认值与测试覆盖情况。

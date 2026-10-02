---
title: 插件开发范式
description: 按修改目标选择依赖、资源、配置、API、日志与验证规范；不必通读全部指南。
---

本目录面向业务 Plugin 和 Part 作者。先定位要改的声明或方法，读对应一页中的相关章节，再检查真实调用方；不要先阅读 Host 的安装配置或框架内部设计。

## 插件基本功

依赖声明、配置、Part 是插件模型的一部分；`ctx.events`、`ctx.logger`、`ctx.effects` 是 Core 自带能力。它们不要求安装 `servicesPreset()`、HTTP 或 Workbench。

| 常见任务                     | 入口                       | 首先掌握的写法与边界                                      |
| ---------------------------- | -------------------------- | --------------------------------------------------------- |
| 调用其他插件                 | [依赖与组成](./model.md)   | 必需依赖用 constructor；可选增强用 `plugins.use()`        |
| 发布和订阅通知               | [事件](./events.md)        | 宿主广播用 `ctx.events`；provider 协议用具名 `EvtChannel` |
| 写日志与诊断                 | [日志](./logging.md)       | `ctx.logger`；人读插值、查询字段和 lazy 分别选择          |
| 初始化、订阅、连接和后台任务 | [生命周期](./lifecycle.md) | `init()` 和 `ctx.effects`；部分失败也必须释放已取得资源   |
| 声明和更新设置               | [配置](./configuration.md) | `configs.use(schema)`；保存与实际应用是不同阶段           |
| 拆分内部资源与局部配置       | [PluginPart](./parts.md)   | 随父插件启停；普通 helper 足够时不用 Part                 |
| 编写和验证插件行为           | [插件测试](./testing.md)   | 实现前确定成功、失败与清理的验证边界，使用真实 test host  |

第一次写插件从[无额外服务的最小示例](../getting-started/first-plugin.md)开始。修改已有代码时，直接读本次主题，不要求依次通读所有基础页。

**能力存在不等于外部效果已经配置。** `ctx.logger` 一直可用，但 console、store、OTLP 输出由 Host 配置；配置声明一直可用，但跨重启保存由 Host 选择。基础 API 的用法与部署设置分别维护。

## 设计原则：涉及对应内容时，在实现前阅读

根据本次改动选择相关章节，用于实现和 review。

| 本次涉及的内容                                | 应读指南                                           | 实现前明确                                                              |
| --------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| 新增或修改 Plugin 方法、RPC、DTO 或资源返回值 | [API 契约](./contracts.md)                         | 调用边界、校验、返回值语义和资源所有权                                  |
| 设计预期失败、恢复分支或多步错误组合          | [失败契约与 Better Result](./better-result.md)     | 调用方怎样恢复、沿用什么契约、是否需要组合器；阅读不等于必须采用 Result |
| 后台任务、并发、取消、重试或在途合并          | [异步组合](./async.md)与[生命周期](./lifecycle.md) | 任务和额度由谁持有，取消与停止后什么工作仍在运行                        |

`@pluxel/async` 是独立工具包，不是 Core 自带服务。设计原则同样适用于未采用该包的代码；根据实际需求选工具，不为统一写法引入依赖。

## 按需扩展：先确认安装前提

默认服务器组合可能已经安装部分服务，但这不是任意 Plugin/Context 的保证。先确认当前 Host 的 services；只有新增需求才修改宿主。其他 Plugin 提供的业务能力则通过依赖图声明。

| 增量需求                       | 入口                                  | 前提                                        |
| ------------------------------ | ------------------------------------- | ------------------------------------------- |
| 对外 HTTP / WebSocket          | [HTTP](./http.md)                     | Host 安装 Elysia 服务并接入 carrier         |
| 命令目录、MCP tool、文本参数   | [Commands](./commands.md)             | 定义 Command 使用独立包；目录与载体另选安装 |
| 数据库 schema、迁移和查询      | [Database](./database.md)             | Host 显式安装 Database 与 backend           |
| 私有凭据与条件写入             | [Vault](./vault.md)                   | Host 安装 Vault，按记录判断是否可写         |
| Node module 与 worker task     | [Node artifacts](./node-artifacts.md) | 选择对应服务与构建产物                      |
| 管理页面                       | [Workbench](../workbench/index.md)    | 可选 UI 能力；关闭时业务仍能独立运行        |
| 现成网络、认证、缓存、渲染能力 | [官方插件](../plugins/index.md)       | 核对公开状态，安装并声明 provider 依赖      |

## 什么时候转到其他文档

- 要安装服务、决定运行哪些插件、绑定部署输入或配置日志输出：转到 [Host 配置教程](../host/configuration.md)的对应章节。
- 要定位源码、执行静态检查或操作运行实例：转到[开发与验证](../development/index.md)。
- 要改 Core、Host、编译器或包边界：转到仓库[工程入口](https://github.com/PluxelJS/pluxel/blob/main/engineering/README.md)，不要把业务写法当作内部实现规范。

完成修改时按[提交检查](./review.md)核对相关设计和实际验证结果。

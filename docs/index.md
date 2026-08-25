---
title: Pluxel 用户文档
description: 从第一个 Plugin 开始，按任务查找 Pluxel 的运行时、官方 Plugin 和交付文档。
icon: BookOpen
---

Pluxel 把业务能力及其依赖、配置和生命周期组织成 Plugin。构建工具检查依赖关系，runtime 负责装载、替换和资源回收。

## 开始使用

1. [编写第一个插件](./getting-started/index.md)：从 CLI 模板完成配置、HTTP 接口和生命周期测试。
2. [Plugin 模型与生命周期](./getting-started/plugin-model.md)：理解必需依赖、可选集成、版本代际、资源回收和失败传播。
3. [使用 PluginPart 组织内部资源](./getting-started/plugin-parts.md)：隔离 owner 内部配置、注册和清理，不制造第二个治理节点。
4. [配置模型](./getting-started/configuration.md)：用一份 Valibot schema 提供类型、默认值、校验和管理界面。
5. [配置插件宿主](./getting-started/host-setup.md)：选择 static 或 dynamic host。

项目来源和依赖模型的取舍见[为什么是 Pluxel](./why-pluxel.md)。HTTP、数据库等宿主能力按需查阅；HTTP client、缓存和服务端渲染等独立 package 见[官方 Plugin](./plugins/index.md)。

## 按任务进入

| 当前任务                               | 只读这一页                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 拆分一个 Plugin 内部的配置与资源       | [使用 PluginPart](./getting-started/plugin-parts.md)                                           |
| 完整验证生命周期、HTTP、配置与资源清理 | [测试插件](./development/testing.md)                                                           |
| 暴露业务 API 或 webhook                | [插件 HTTP](./runtime/http.md)                                                                 |
| 数据库或加密小数据                     | [数据库](./runtime/database.md)、[Vault](./runtime/vault.md)                                   |
| CPU 密集任务或独立 Node ESM            | [Node 模块与 Worker 任务](./runtime/node-artifacts.md)                                         |
| 管理界面或 schema 表单                 | [管理工作台](./workbench/index.md)、[配置 Playground](./workbench/configuration-playground.md) |
| HTTP client、缓存、Redis、存储或遥测   | [官方 Plugin](./plugins/index.md)                                                              |
| 服务端字体、Canvas 或图表              | [服务端渲染 Plugin](./plugins/rendering/index.md)                                              |
| Agent、CLI 或消息指令                  | [Commands 与 Agent tools](./runtime/commands.md)                                               |
| 构建、发布、HMR 或跨仓库联调           | [CLI 与工具链](./development/tooling.md)                                                       |
| 定位错误或确认公开入口                 | [排错](./reference/troubleshooting.md)、[Package 矩阵](./reference/package-matrix.md)          |

`docs/` 记录当前用户 API。源码仓库中的 [engineering](https://github.com/PluxelJS/pluxel/tree/main/engineering) 用于工程设计和历史提案，不作为用户 API 依据。

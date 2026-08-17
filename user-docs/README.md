---
title: Pluxel 用户文档
description: 先认识 Pluxel 的设计，再从第一个插件逐步走向完整宿主。
---

# Pluxel 用户文档

Pluxel 把一项业务能力连同它的依赖、配置和生命周期组织成 Plugin。框架在构建期验证依赖关系，在运行时负责装载、替换和资源回收。

## 从这里开始

- 想先了解项目的来历和设计取舍，阅读[为什么是 Pluxel](./why-pluxel.md)。这篇文档说明 Pluxel 与 Cordis、Koishi 的渊源，以及为什么业务依赖使用构造器注入，而宿主公共能力保留在 Context。
- 想直接动手，阅读[编写第一个插件](./getting-started/index.md)。你会创建一个带配置和 HTTP 接口的 Plugin，并用真实宿主完成测试。

## 推荐阅读顺序

1. [编写第一个插件](./getting-started/index.md)：完成插件包、配置、实现、宿主启用和生命周期测试。
2. [Plugin 模型与生命周期](./getting-started/plugin-model.md)：理解必需依赖、可选集成、版本代际、资源回收和失败传播。
3. [配置模型](./getting-started/configuration.md)：让一个 Valibot schema 同时提供类型、默认值、校验和管理界面。
4. [配置插件宿主](./getting-started/host-setup.md)：在静态与动态模式中选择一种，装配可运行的宿主。

读完这四篇，你就能判断一项能力是否应该成为 Plugin，以及它的依赖、配置、资源和宿主入口分别属于哪里。HTTP、数据库、缓存等能力可以在需要时再查阅。

## 按任务进入

| 当前任务                               | 只读这一页                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 完整验证生命周期、HTTP、配置与资源清理 | [测试插件](./development/testing.md)                                                             |
| 暴露业务 API 或 webhook                | [插件 HTTP](./runtime/http.md)                                                                   |
| 数据库、加密小数据、对象存储           | [数据库](./runtime/database.md)、[Vault](./runtime/vault.md)、[S3 存储](./runtime/storage.md)    |
| 缓存、限流、Redis                      | [缓存](./runtime/cache.md)、[请求频率控制](./runtime/rates.md)、[Redis](./runtime/redis.md)      |
| CPU 密集任务或独立 Node ESM            | [Node 模块与 Worker 任务](./runtime/node-artifacts.md)                                           |
| 管理界面或 schema 表单                 | [管理工作台](./workbench/index.md)、[配置 Playground](./workbench/configuration-playground.md)   |
| 服务端字体、Canvas 或图表              | [字体](./rendering/fonts.md)、[Canvas](./rendering/canvas.md)、[ECharts](./rendering/echarts.md) |
| Agent、CLI 或消息指令                  | [Commands 与 Agent tools](./runtime/commands.md)                                                 |
| 构建、发布、HMR 或跨仓库联调           | [CLI 与工具链](./development/tooling.md)                                                         |
| 定位错误或确认公开入口                 | [排错](./reference/troubleshooting.md)、[Package 矩阵](./reference/package-matrix.md)            |

## 文档边界

`user-docs/` 是用户文档的唯一正文来源，可以在仓库或文档网站中阅读。维护者架构位于 `docs/`；提案和历史记录不代表当前公开 API。

文档网站还提供以下机器可读入口：

- 索引：`/llms.txt`
- 全部 Markdown：`/llms-full.txt`
- 单页 Markdown：`/llms.mdx/docs/<slug>/content.md`
- 文档页也支持 `/docs/<slug>.md` 和 `Accept: text/markdown`

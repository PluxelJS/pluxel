---
title: Pluxel 用户文档
description: 用四篇入门文档完成 Plugin、配置和宿主装配，再按任务查阅专题。
---

# Pluxel 用户文档

Pluxel Plugin 是具有依赖、配置和生命周期的能力单元。入门路径包含四篇文档；其他页面按任务查阅。

## 四篇入门文档

1. [编写第一个插件](./getting-started/index.md)：在一页内完成 package、配置、Plugin、宿主启用和 lifecycle test。
2. [Plugin 模型与生命周期](./getting-started/plugin-model.md)：理解 required/optional dependency、generation、effects 和失败传播。
3. [配置模型](./getting-started/configuration.md)：让一个 Valibot schema 成为类型、默认值、校验和管理 UI 的共同真源。
4. [配置插件宿主](./getting-started/host-setup.md)：只选择 static 或 dynamic 其中一条 route，完成可运行宿主。

完成后可以确定 Plugin 的依赖、启动条件、配置来源、资源所有权和宿主入口。运行时能力不属于入门前置内容。

## 按任务进入

| 当前任务                                    | 只读这一页                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 完整验证 lifecycle、HTTP、config 与 cleanup | [测试插件](./development/testing.md)                                                             |
| 暴露业务 API 或 webhook                     | [插件 HTTP](./runtime/http.md)                                                                   |
| 数据库、加密小数据、对象存储                | [数据库](./runtime/database.md)、[Vault](./runtime/vault.md)、[S3 存储](./runtime/storage.md)    |
| 缓存、限流、Redis                           | [缓存](./runtime/cache.md)、[请求频率控制](./runtime/rates.md)、[Redis](./runtime/redis.md)      |
| CPU 密集任务或独立 Node ESM                 | [Node module 与 worker task](./runtime/node-artifacts.md)                                        |
| 管理界面或 schema 表单                      | [管理工作台](./workbench/index.md)、[配置 Playground](./workbench/configuration-playground.md)   |
| 服务端字体、Canvas 或图表                   | [字体](./rendering/fonts.md)、[Canvas](./rendering/canvas.md)、[ECharts](./rendering/echarts.md) |
| Agent、CLI 或消息指令                       | [Commands 与 Agent tools](./runtime/commands.md)                                                 |
| 构建、发布、HMR 或跨仓库联调                | [CLI 与工具链](./development/tooling.md)                                                         |
| 定位错误或确认公开入口                      | [排错](./reference/troubleshooting.md)、[Package 矩阵](./reference/package-matrix.md)            |

## 内容与机器接口

`user-docs/` 是唯一正文来源：仓库中可直接阅读，线上由 Fumapress 提供导航、搜索、类型提示和交互预览。

- 索引：`/llms.txt`
- 全部 Markdown：`/llms-full.txt`
- 单页 Markdown：`/llms.mdx/docs/<slug>/content.md`
- 文档页也支持 `/docs/<slug>.md` 和 `Accept: text/markdown`

维护者架构位于 `docs/`；proposal 和历史记录不是当前用户 API。

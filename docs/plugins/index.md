---
title: 官方 Plugin
description: 按需选择 Pluxel 团队维护的认证、HTTP、缓存、存储、可观测性和服务端渲染 Plugin。
icon: Blocks
---

Pluxel 的核心 package 提供 Plugin 模型、依赖图、生命周期和宿主能力。这里列出的 package 是使用这些公开机制构建的官方 Plugin，不是运行 Pluxel 的必需依赖。应用只安装实际需要的 Plugin。

## 可公开安装

| Plugin                | 用途                               | 文档                                     |
| --------------------- | ---------------------------------- | ---------------------------------------- |
| `@pluxel/agent-tools` | Agent Toolset 与 command allowlist | [Agent tools](./agent-tools.md)          |
| `@pluxel/auth`        | Workbench 与 Management API 认证   | [Management 认证](./auth.md)             |
| `@pluxel/wretch`      | 带宿主出站策略的 HTTP client       | [Wretch HTTP client](./wretch.md)        |
| `@pluxel/fonts`       | 服务端字体发现与管理               | [服务端字体](./rendering/fonts.md)       |
| `@pluxel/canvas`      | 服务端 Canvas 与图片处理           | [服务端 Canvas](./rendering/canvas.md)   |
| `@pluxel/echarts`     | 服务端 ECharts 渲染                | [服务端 ECharts](./rendering/echarts.md) |
| `@pluxel/takumi`      | HTML/node-tree 图片渲染            | [Takumi](./rendering/takumi.md)          |

这些 package 已声明公共入口。具体可安装版本以 npm registry 和发布记录为准。

## Workspace 预览（不可安装）

以下 Plugin 目前仍是 Pluxel workspace 的内部集成，不是仓库外项目可以依赖的公开 package。文档用于说明当前能力和验证设计，不构成发布承诺。

| Plugin                    | 用途                               | 文档                                    |
| ------------------------- | ---------------------------------- | --------------------------------------- |
| `@pluxel/cache`           | Plugin 隔离的缓存与后端抽象        | [缓存](./cache.md)                      |
| `@pluxel/rates`           | 按调用方和成本执行频率限制         | [请求频率控制](./rates.md)              |
| `@pluxel/redis`           | Redis client、Lua script 和后端    | [Redis](./redis.md)                     |
| `@pluxel/storage`         | 本地或远端 S3 对象存储             | [S3 对象存储](./storage.md)             |
| `@pluxel/otel`            | OpenTelemetry signals 与 exporters | [OpenTelemetry](./otel.md)              |
| `@pluxel/package-manager` | 动态宿主的受控 package source      | [Package manager](./package-manager.md) |

公开状态和允许导入的入口以 [Package 与入口矩阵](../reference/package-matrix.md) 为准。

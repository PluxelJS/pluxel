---
title: 添加官方插件
description: 将官方插件加入应用清单、配置和启动策略，并按任务选择公开包。
icon: Blocks
---

先用 [快速开始](../getting-started/index.md) 创建并跑通应用，再按业务任务添加插件。宿主可安装 [HTTP](../plugin-development/http.md)、[日志](../plugin-development/logging.md)、[数据库](../plugin-development/database.md) 与 [Worker](../plugin-development/node-artifacts.md) 等服务；本目录提供认证、出站请求、图像生成等可选能力。

## 把一个插件加入应用

以出站 HTTP 为例，快速开始生成的项目使用命名 catalog 管理依赖。在工作区根目录运行：

```sh
pnpm catalog:add -- @pluxel/wretch
pnpm install
pnpm governance:check
```

在 pncat 的包选择界面中选中直接导入它的 `package.json`：宿主入口需要 `host/package.json`；如果业务插件在独立的 `plugins/` 包内，该包也要选中。pncat 将版本写入 `pluxel` catalog，并为所选包写入 `catalog:pluxel` 引用。下文各插件的安装命令沿用这个工作流，依赖管理细节见 [示例项目](../development/starter-monorepo.md#添加依赖)。

已有、不使用 catalog 的应用可以在对应包目录执行 `npx nypm add @pluxel/wretch`。使用哪种包管理方式不改变下面的宿主装配。

安装只让代码可导入。把 provider 和 consumer 加入应用的 `plugins` 清单，在 `state.initial.autoStart` 中选择业务 consumer；它的 required dependencies 会随图启动。应用入口与初始配置只按 [Host 配置教程](../host/configuration.md#应用入口)维护，不在每个插件指南重复装配宿主。

业务代码通过 constructor dependency 使用 provider，见[插件模型](../plugin-development/model.md#required-dependency)。例如 Wretch 的 consumer 实现见[HTTP client](./wretch.md#第一个-http-consumer)。

本目录 `host.start(Plugin, { initialConfig })` 示例中的 host 是[隔离测试宿主](../plugin-development/testing.md)，不能复制到生产启动文件。运行应用用 HostApplication；在线状态用[dev console](../development/dev-console.md)确认。缺少 provider 查 catalog，启动失败查配置/依赖报告，调用失败按对应插件的领域契约处理。

## 可公开安装

| Plugin                          | 用途                                     | 文档                                               |
| ------------------------------- | ---------------------------------------- | -------------------------------------------------- |
| `@pluxel/auth`                  | Workbench 与 Management API 认证         | [Management 认证](./auth.md)                       |
| `@pluxel/wretch`                | 带宿主出站策略的 HTTP client             | [Wretch HTTP client](./wretch.md)                  |
| `@pluxel/fonts`                 | 服务端字体发现与管理                     | [服务端字体](./rendering/fonts.md)                 |
| `@pluxel/canvas`                | 服务端 Canvas、图片处理与静态表格        | [服务端 Canvas](./rendering/canvas.md)             |
| `@pluxel/echarts`               | 服务端 ECharts 渲染                      | [服务端 ECharts](./rendering/echarts.md)           |
| `@pluxel/takumi`                | HTML/node-tree 图片渲染                  | [Takumi](./rendering/takumi.md)                    |
| `@pluxel/takumi-markdown`       | GFM Markdown、表格与固定代码高亮图片渲染 | [Markdown / Typst](./rendering/takumi-markdown.md) |
| `@pluxel/takumi-markdown-typst` | 可选受限 Typst 数学 SVG 扩展             | [Markdown / Typst](./rendering/takumi-markdown.md) |

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
| `@pluxel/package-manager` | Native/Vite 的受控目录来源         | [Package manager](./package-manager.md) |

公开状态和允许导入的入口以 [Package 与入口矩阵](../reference/package-matrix.md) 为准。

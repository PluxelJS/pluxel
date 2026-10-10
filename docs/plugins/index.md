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

## 同一配置用于独立部署与 Workbench

官方插件导出传给 `configs.use()` 的同一个配置 schema。应用通过 Host 初始配置、`envBinding` 或 `fileBinding` 提供部署输入，Workbench 编辑保存层；校验、默认值和插件消费的配置始终由该 schema 定义。环境名称由应用显式选择，插件不另外实现自己的环境变量配置系统。字段绑定与来源优先级见 [Host 配置](../host/configuration.md#绑定部署环境与-json-文件)，secret 使用同页的 Vault 部署绑定。

例如，以下是无 Workbench 的生产应用入口，出站 HTTP 策略全部由环境提供，基础 client 无需附加服务：

```ts no-twoslash
import { pluginNodeAddressOf } from '@pluxel/core'
import { defineHostApplication, envBinding } from '@pluxel/host'
import { WretchPlugin, WretchConfig } from '@pluxel/wretch'

export default defineHostApplication(() => ({
	plugins: [WretchPlugin],
	services: [],
	state: { initial: { autoStart: [pluginNodeAddressOf(WretchPlugin)] } },
	envBindings: [
		envBinding(WretchPlugin, {
			config: {
				schema: WretchConfig,
				mapping: { timeoutMs: 'HTTP_TIMEOUT_MS', allowedOrigins: 'HTTP_ORIGINS' },
			},
		}),
	],
}))
```

`HTTP_TIMEOUT_MS=30000`、`HTTP_ORIGINS='["https://api.example.com"]'` 分别提供数字和 JSON 数组。业务 consumer 加入清单并通过 constructor 注入 WretchPlugin。改动 env/file 后重新创建 Host；Host API 保存配置后的应用状态与是否需要 restart 按[插件配置](../plugin-development/configuration.md)维护。

Workbench 服务是否安装不决定业务配置是否可用。按实际能力选择 Host 服务：

| 能力                                            | 服务前提                                                       |
| ----------------------------------------------- | -------------------------------------------------------------- |
| Fonts 核心、Canvas、Takumi、Markdown            | 不要求 Workbench 或 Persistence；字体文件可由 FontsConfig 提供 |
| ECharts、Typst 文档及 Typst 数学编译            | NodeModules 与 Workers，并正确定位构建制品或开发编译器         |
| Fonts 保存偏好/上传集合、Wretch opt-in 受管设置 | Persistence；程序化 API 同样可在无 Workbench 时使用            |
| S3 与 Auth 部署凭据                             | Vault；Auth 另需管理访问能力，TOTP 等可变凭据需要可写 backend  |
| Redis、Cache、Rates、Otel、Package Manager      | 按所属指南选择后端、来源和服务；没有 Workbench 前置条件        |

插件指南区分部署配置、业务保存状态和调用参数。上传字体、已安装 package、缓存条目、consumer 请求设置等仍属于各自领域状态，不因提供环境变量就变成第二套配置。Otel 的 `OTEL_*` 保留上游 SDK 的进程环境契约。

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
| `@pluxel/typst`           | Typst 文档会话、Vector 预览与 PDF  | [Typst 文档](./rendering/typst.md)      |
| `@pluxel/cache`           | Plugin 隔离的缓存与后端抽象        | [缓存](./cache.md)                      |
| `@pluxel/rates`           | 按调用方和成本执行频率限制         | [请求频率控制](./rates.md)              |
| `@pluxel/redis`           | Redis client、Lua script 和后端    | [Redis](./redis.md)                     |
| `@pluxel/storage`         | 本地或远端 S3 对象存储             | [S3 对象存储](./storage.md)             |
| `@pluxel/otel`            | OpenTelemetry signals 与 exporters | [OpenTelemetry](./otel.md)              |
| `@pluxel/package-manager` | Native/Vite 的受控目录来源         | [Package manager](./package-manager.md) |

公开状态和允许导入的入口以 [Package 与入口矩阵](../reference/package-matrix.md) 为准。

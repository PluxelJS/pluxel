---
title: 添加官方插件
description: 将官方插件加入应用清单、配置和启动策略，并按任务选择公开包。
icon: Blocks
---

先用 [快速开始](../getting-started/index.md) 创建并跑通应用，再按业务任务添加插件。运行时已提供 [HTTP](../runtime/http.md)、[日志](../runtime/logging.md)、[数据库](../runtime/database.md) 与 [Worker](../runtime/node-artifacts.md) API；本目录提供认证、出站请求、图像生成等可选能力。

## 把一个插件加入应用

以出站 HTTP 为例，快速开始生成的项目使用命名 catalog 管理依赖。在工作区根目录运行：

```sh
pnpm catalog:add -- @pluxel/wretch
pnpm install
pnpm governance:check
```

在 pncat 的包选择界面中选中直接导入它的 `package.json`：宿主入口需要 `host/package.json`；如果业务插件在独立的 `plugins/` 包内，该包也要选中。pncat 将版本写入 `pluxel` catalog，并为所选包写入 `catalog:pluxel` 引用。下文各插件的安装命令沿用这个工作流，依赖管理细节见 [示例项目](../development/starter-monorepo.md#添加依赖)。

已有、不使用 catalog 的应用可以在对应包目录执行 `npx nypm add @pluxel/wretch`。使用哪种包管理方式不改变下面的宿主装配。

安装只让代码可导入。还要在应用的 static 入口把 provider 加入 `plugins` 清单，并让需要它的业务插件自动启动：

```ts no-twoslash
import { pluginNodeAddressOf } from '@pluxel/runtime'
import { defineStaticRuntime } from '@pluxel/runtime-static'
import { WretchPlugin } from '@pluxel/wretch'
import { CustomerPlugin } from './customer-plugin.js'

export default defineStaticRuntime({
	name: 'my-app',
	plugins: [WretchPlugin, CustomerPlugin],
	configure: () => ({
		runtimeState: {
			snapshot: { autoStart: [pluginNodeAddressOf(CustomerPlugin)] },
		},
		configService: {
			snapshot: {
				plugins: [
					{
						owner: pluginNodeAddressOf(CustomerPlugin),
						config: { baseUrl: 'https://catalog.example' },
					},
				],
			},
		},
	}),
})
```

把 `CustomerPlugin` 保存为入口相邻的 `customer-plugin.ts`，完整实现见 [Wretch](./wretch.md#第一个-http-consumer)。它通过构造函数依赖 `WretchPlugin`，因此启动 consumer 时会一起启动 provider。把这段配置合入现有入口，保留项目已有的插件、启动项和配置记录。

启动后在 Workbench 确认 consumer 与 provider 都处于运行状态，再调用业务方法验证结果。缺少依赖时先检查 `plugins` 清单；配置无效时查看该插件的启动错误。无界面应用通过 [开发控制台](../development/dev-console.md) 或测试读取状态。

本目录的 `host.start()`、`host.commit()`、`initialConfig` 示例用于 [Runtime 测试宿主](../development/testing.md)，不要复制到生产启动文件。应用使用上面的配置记录与自动启动策略；动态宿主和持久化配置见 [宿主配置](../getting-started/host-setup.md)。

## 按任务选择

| 你要完成的任务             | 从这里开始                         |
| -------------------------- | ---------------------------------- |
| 保护管理工作台             | [Management 认证](./auth.md)       |
| 调用外部 HTTP API          | [Wretch](./wretch.md)              |
| 把业务命令提供给 Agent     | [Agent tools](./agent-tools.md)    |
| 生成分享图、图表或文档图片 | [服务端渲染](./rendering/index.md) |

以下清单区分公开包与仓库内部预览；先确认可用范围，再选择 API。

## 可公开安装

| Plugin                          | 用途                                     | 文档                                               |
| ------------------------------- | ---------------------------------------- | -------------------------------------------------- |
| `@pluxel/agent-tools`           | Agent Toolset 与 command allowlist       | [Agent tools](./agent-tools.md)                    |
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

| Plugin                    | 用途                                 | 文档                                    |
| ------------------------- | ------------------------------------ | --------------------------------------- |
| `@pluxel/cache`           | Plugin 隔离的缓存与后端抽象          | [缓存](./cache.md)                      |
| `@pluxel/rates`           | 按调用方和成本执行频率限制           | [请求频率控制](./rates.md)              |
| `@pluxel/redis`           | Redis client、Lua script 和后端      | [Redis](./redis.md)                     |
| `@pluxel/storage`         | 本地或远端 S3 对象存储               | [S3 对象存储](./storage.md)             |
| `@pluxel/otel`            | OpenTelemetry signals 与 exporters   | [OpenTelemetry](./otel.md)              |
| `@pluxel/package-manager` | 动态宿主的受控 package source        | [Package manager](./package-manager.md) |
| `@pluxel/pi-agent`        | Pi embedded engine、goal 与 subagent | [Pi Agent](./pi-agent.md)               |

公开状态和允许导入的入口以 [Package 与入口矩阵](../reference/package-matrix.md) 为准。

---
title: 官方插件总览
description: 浏览官方提供的现成插件，涵盖 HTTP 客户端、身份认证、缓存、存储与服务端渲染能力。
icon: Blocks
---

除了框架的核心运行时，Pluxel 官方生态还提供了一系列开箱即用的插件。这些插件遵循统一的强类型依赖、Valibot 配置与确定性生命周期规范，帮助你快速拼装出生产级的后端应用。

<span id="把一个插件加入应用"></span>
## 把一个插件加入应用

以引入出站 HTTP 客户端插件 `@pluxel/plugin-wretch` 为例：

### 1. 安装依赖

在项目根目录下通过包管理器添加依赖：

```sh
pnpm add @pluxel/plugin-wretch
```

如果你的项目使用 pnpm catalog 统一管理版本，也可以运行：

```sh
vp exec pluxel pncat add @pluxel/plugin-wretch
vp install
```

### 2. 在宿主中注册插件

在应用的 `src/app.ts` 中，将插件加入 `plugins` 清单；如果需要在冷启动时主动运行，可加入 `policy.autoStart`：

```ts no-twoslash
import { defineHostApplication } from '@pluxel/host'
import { WretchPlugin } from '@pluxel/plugin-wretch'
import { MyBusinessPlugin } from './my-plugin'

export default defineHostApplication(() => ({
	// 注册可用插件
	plugins: [WretchPlugin, MyBusinessPlugin],
	// 启动策略
	policy: { autoStart: [MyBusinessPlugin] },
}))
```

### 3. 在业务插件中注入使用

业务插件通过构造函数直接注入提供方实例：

```ts no-twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import { WretchPlugin } from '@pluxel/plugin-wretch'

@Plugin()
export class MyBusinessPlugin extends BasePlugin {
	constructor(private readonly http: WretchPlugin) {
		super()
	}

	async fetchRemoteData() {
		return this.http.client().url('https://api.example.com/data').get().json()
	}
}
```

## 可公开发布安装的插件

以下插件均已在 npm 上公开发布：

| 插件包名 | 核心能力 | 使用文档 |
| --- | --- | --- |
| **`@pluxel/plugin-wretch`** | 出站 HTTP 客户端，支持超时、重试与域名白名单策略 | [Wretch HTTP 客户端](./wretch.md) |
| **`@pluxel/plugin-auth`** | Workbench 管理界面与 Management API 认证 | [认证与鉴权](./auth.md) |
| **`@pluxel/plugin-playwright`** | 远程 CDP / Playwright 浏览器自动化与会话隔离 | [浏览器自动化](./browser.md) |
| **`@pluxel/plugin-invoice`** | 发票票据 OCR 结构化提取与查验编排 | [票据识别与查验](./invoice.md) |
| **`@pluxel/plugin-fonts`** | 服务端中英文字体库扫描、加载与分发 | [服务端字体](./rendering/fonts.md) |
| **`@pluxel/plugin-canvas`** | 基于 Skia 的高性能服务端 Canvas 绘图与图片合成 | [服务端 Canvas](./rendering/canvas.md) |
| **`@pluxel/plugin-echarts`** | 服务端图表生成与 SVG/PNG 渲染 | [服务端 ECharts](./rendering/echarts.md) |
| **`@pluxel/plugin-takumi`** | JSX/HTML 原生模板渲染引擎 | [Takumi 渲染](./rendering/takumi.md) |
| **`@pluxel/plugin-takumi-markdown`** | GFM Markdown 解析、代码语法高亮与数学公式排版 | [Markdown 渲染](./rendering/takumi-markdown.md) |

## 工作区插件（持续孵化中）

以下插件为 Pluxel 工作区内建的基础套件：

| 插件包名 | 核心能力 | 使用文档 |
| --- | --- | --- |
| **`@pluxel/plugin-redis`** | Redis 客户端连接池、分布式锁与 Lua 脚本 | [Redis 客户端](./redis.md) |
| **`@pluxel/plugin-storage`** | S3 兼容的对象存储服务，支持本地与云端存储 | [S3 对象存储](./storage.md) |
| **`@pluxel/plugin-cache`** | 插件级隔离的多级缓存抽象与后端适配 | [缓存服务](./cache.md) |
| **`@pluxel/plugin-rates`** | 基于令牌桶/滑动窗口的 API 频率限制 | [请求限流](./rates.md) |
| **`@pluxel/plugin-otel`** | OpenTelemetry 指标与链路追踪数据上报 | [OpenTelemetry](./otel.md) |
| **`@pluxel/plugin-typst`** | 基于 Typst 的高性能排版、矢量图与 PDF 渲染 | [Typst 文档排版](./rendering/typst.md) |

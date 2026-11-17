---
title: 服务端 Apache ECharts
description: 通过 Fonts、Canvas 和共享 Worker 在服务端渲染 Apache ECharts 6 图片。
---

`@pluxel/plugin-echarts` 基于 Apache ECharts 6 在服务端生成 PNG、JPEG 或 WebP 格式的图表图片。它结合 `CanvasPlugin` 与 `FontsPlugin`，将排版、ZRender 绘制和图片编码全部调度至 Worker 工作线程中异步执行，避免同步渲染阻塞 Node.js 事件循环。

## 安装与引入

在工作区中添加依赖：

```sh
vp exec pluxel pncat add @pluxel/plugin-echarts @pluxel/plugin-canvas @pluxel/plugin-fonts
```

在插件中声明注入并渲染图表：

```ts twoslash
import type { Buffer } from 'node:buffer'
import { EChartsPlugin } from '@pluxel/plugin-echarts'
import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin()
export class ReportsPlugin extends BasePlugin {
	constructor(private readonly charts: EChartsPlugin) {
		super()
	}

	async renderSales(): Promise<Buffer> {
		const result = await this.charts.render({
			width: 1200,
			height: 630,
			option: {
				xAxis: { type: 'category', data: ['Mon', 'Tue', 'Wed'] },
				yAxis: { type: 'value' },
				series: [{ type: 'bar', data: [120, 200, 150] }],
			},
		})
		return result.data
	}
}
```

- `result.data` 返回图片的二进制数据（`Buffer`）。
- 生成图片可直接用于保存文件、写入邮件附件或通过 HTTP 响应发送。

## 渲染参数与输出格式

`render()` 支持指定尺寸、像素比（DPR）、主题和图片压缩格式：

```ts no-twoslash
const result = await this.charts.render({
	width: 800,
	height: 400,
	devicePixelRatio: 2,
	option,
	output: { format: 'webp', quality: 85 },
	signal,
})

console.log(result.mediaType) // 'image/webp'
console.log(result.width, result.height) // 800, 400 (逻辑尺寸)
```

- `output.format` 支持 `png`（默认）、`jpeg` 以及 `webp`。
- `output.quality` 接受 0 到 100 的数值（仅对 JPEG 和 WebP 生效）。
- `signal` 支持传入 `AbortSignal` 用于主动取消队列排队或渲染计算。

## 自定义主题

可通过 `registerTheme()` 为当前插件注册专属的 ECharts 主题：

```ts no-twoslash
const theme = this.charts.registerTheme({
	name: 'reports',
	theme: {
		color: ['#2563eb', '#16a34a'],
		backgroundColor: '#ffffff',
	},
})

await this.charts.render({
	width: 800,
	height: 400,
	option,
	theme: theme.name,
})

// 不再使用时可提前注销，插件停止时也会自动清理
theme.dispose()
```

- 主题定义为标准 JSON 对象。
- 系统同时内置了 `'default'` 和 `'dark'` 两套基础主题。

## 默认字体集成

若未在 `option` 或主题中显式指定 `textStyle.fontFamily`，渲染器会自动读取 `FontsPlugin` 的全局默认字体族。管理员在 Workbench 控制台中修改默认字体后，后续渲染的图表将自动采用新字体。

## 图片资源（Data URL）支持

当图表 option 中包含散点图标、背景图等图片标记时，支持使用 Data URL：

- 图片会在进入 Worker 绘制前被统一解码并受到单次渲染总像素和大小限制。
- 为保证服务端执行安全，ECharts 渲染不直接发起远程 HTTP 请求；若需展示外部图片，请预先下载并转为 Data URL 传入。

## Worker 线程与输入限制

- ECharts 的 SSR 计算由宿主共享的 Worker 服务托管。
- 由于 option 需要序列化传入 Worker 线程，请使用纯 JSON 数据结构（Object、Array、数字、字符串）；不支持函数回调形式的 formatter（可改用 ECharts 模板字符串，如 `'{b}: {c}'`）。

## 配置项与配额

通过 `EChartsConfig` 可以在应用层调整限制参数：

| 配置项                    | 默认值   | 说明                                       |
| :------------------------ | :------- | :----------------------------------------- |
| `defaultDevicePixelRatio` | `1`      | 未显式传入 DPR 时的默认倍率                |
| `maxDevicePixelRatio`     | `4`      | 单次渲染允许的最大 DPR 上限                |
| `maxOptionBytes`          | `8 MiB`  | Option 配置结构允许的最大序列化体积        |
| `maxOutputBytes`          | `64 MiB` | 渲染生成的单张图片最大体积                 |
| `maxTotalImagePixels`     | `16.8 M` | 单次渲染中所有内嵌图片解码后的最大总像素数 |

## 错误处理与 Result 封装

在图表队列繁忙或渲染排队超时时，可捕获 `RENDER_BUSY` 错误并封装为业务层提示：

```ts twoslash
import { Result, TaggedError } from '@pluxel/core/better-result'
import {
	EChartsError,
	type EChartsPlugin,
	type EChartsRenderInput,
	type EChartsRenderResult,
} from '@pluxel/plugin-echarts'

export class ChartBusy extends TaggedError('ChartBusy')<{ message: string }> {}

export async function renderChart(
	charts: EChartsPlugin,
	input: EChartsRenderInput,
): Promise<Result<EChartsRenderResult, ChartBusy>> {
	try {
		return Result.ok(await charts.render(input))
	} catch (error) {
		if (error instanceof EChartsError && error.code === 'RENDER_BUSY') {
			return Result.err(new ChartBusy({ message: '图表渲染队列已满，请稍后重试' }))
		}
		throw error
	}
}
```

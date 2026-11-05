---
title: 服务端 Canvas
description: 在服务端绘制位图与 SVG，解码图片、排版文字和生成静态数据表，并用资源预算约束原生内存。
---

`@pluxel/plugin-canvas` 基于高性能的 `@napi-rs/canvas` 提供服务端绘图能力，涵盖 2D 位图绘制、SVG 矢量图导出、图片安全解码、Pretext 高性能文本排版以及轻量静态表格绘制。

`CanvasPlugin` 依赖 `FontsPlugin` 提供的字体基础设施，同时也作为 `EChartsPlugin` 的底层渲染支持。

## 安装与引入

在工作区中添加依赖：

```sh
vp exec pluxel pncat add @pluxel/plugin-canvas @pluxel/plugin-fonts
```

在插件中注入 `CanvasPlugin` 并绘制图形：

```ts twoslash
import type { Buffer } from 'node:buffer'
import { CanvasPlugin, Path2D } from '@pluxel/plugin-canvas'
import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin()
export class BadgePlugin extends BasePlugin {
	constructor(private readonly canvas: CanvasPlugin) {
		super()
	}

	async render(): Promise<Buffer> {
		const surface = this.canvas.createCanvasSync(640, 320)
		const context = surface.getContext('2d')

		context.fillStyle = '#111827'
		context.fillRect(0, 0, surface.width, surface.height)
		context.font = `48px ${this.canvas.defaultFont.cssFamily}`
		context.fillStyle = '#fff'
		context.fillText('Pluxel', 48, 180)

		context.stroke(new Path2D('M48 205 H250'))
		return surface.encode('png')
	}
}
```

- `createCanvasSync()` 返回底层的原生 Canvas 实例，包含标准的 W3C 2D 上下文 API。
- 绘制完成后可直接调用 `surface.encode('png')` 或 `surface.encode('jpeg')` 获取图片二进制 Buffer。

## 绘制位图与 SVG 矢量图

支持同步创建位图表面或 SVG 矢量图：

```ts no-twoslash
// 创建 1200x630 位图画布
const raster = this.canvas.createCanvasSync(1200, 630)

// 创建 SVG 画布，支持紧凑模式与路径文字模式
const svg = this.canvas.createSvgCanvasSync(1200, 630, {
	mode: 'text-to-paths',
})
const svgBytes = svg.getContent()
```

SVG 导出模式说明：
- `compact`（默认）：输出精简的标准 SVG。
- `text-to-paths`：将文本预先渲染为贝塞尔曲线路径（Paths），在目标阅读环境缺乏相应字体时可保证字形绝对一致。
- `relative-paths`：使用相对坐标编码路径指令。

## 服务端图片解码

为防范恶意大图消耗过多内存，解码操作由系统预算统一控制：

```ts no-twoslash
const response = await fetch('https://example.com/avatar.png')
const bytes = new Uint8Array(await response.arrayBuffer())

const image = await this.canvas.decodeImage(bytes, { signal })
const surface = this.canvas.createCanvasSync(image.width, image.height)
surface.getContext('2d').drawImage(image, 0, 0)
```

- `decodeImage()` 会在解码前检查文件大小，解码后检查图片宽高与总像素上限。
- 默认为借用模式（`borrowed`），数据会在安全隔离区解码；若传入 `dataOwnership: 'owned'`，可直接移交底层内存以避免二次拷贝。

## 高性能文本排版与 Pretext

`CanvasPlugin` 集成了 `@chenglou/pretext` 的纯计算排版算法，在无需频繁操作 DOM 或复杂排版库的情况下完成高效的换行与测量：

```ts no-twoslash
import { layoutWithLines } from '@pluxel/plugin-canvas/pretext'

const prepared = this.canvas.prepareTextSync({
	text: '一段需要按宽度自动断行并测量高度的长文本...',
	fontSize: 18,
	whiteSpace: 'normal',
	wordBreak: 'normal',
})

// 计算在 360px 宽度、24px 行高下的排版行信息
const layout = layoutWithLines(prepared, 360, 24)
```

- `prepareTextSync()`：预计算常规文本字形信息。
- `prepareTextWithSegmentsSync()`：保留词元与断行段落信息，方便在 Canvas 上逐行绘制。
- `prepareRichInlineSync()`：支持不同字号、加粗、间距的行内富文本排版。

## 渲染静态数据表格

`@pluxel/plugin-canvas/table` 提供了一站式的数据报表渲染工具：

```ts no-twoslash
import { drawTable, layoutTable } from '@pluxel/plugin-canvas/table'

const table = layoutTable({
	width: 640,
	columns: [
		{ header: '服务名称', weight: 2 },
		{ header: '当前状态', width: 112, textAlign: 'center' },
		{ header: '延迟 (P95)', width: 88, textAlign: 'right' },
	],
	rows: [
		['API Gateway', '正常', '18 ms'],
		['Worker Node', '高负载', '81 ms'],
	],
	body: {
		font: `14px ${this.canvas.defaultFont.cssFamily}`,
		lineHeight: 20,
		padding: 6,
	},
	header: {
		font: `700 14px ${this.canvas.defaultFont.cssFamily}`,
		background: '#e2e8f0',
	},
	prepareText: (input) => this.canvas.prepareTextWithSegmentsSync(input),
})

const height = Math.ceil(table.bounds.height)
const surface = this.canvas.createCanvasSync(640, height)
drawTable(surface.getContext('2d'), table)
```

- 支持固定宽度与按权重分配剩余宽度的自适应列。
- 支持单行溢出省略（`ellipsis`）或多行换行。
- 通过 `paintCell` 回调可完全自定义特定单元格的绘制逻辑。

## 在 Worker 线程中渲染

由于原生 Canvas 对象不能跨线程传递，在多工作线程任务中，主线程可将配置快照传入 Worker 中重建适配器：

```ts no-twoslash
// 主线程获取无状态配置快照
const snapshot = this.canvas.workerSnapshot

// Worker 线程中初始化适配器
import { createCanvasWorkerAdapter } from '@pluxel/plugin-canvas/worker'

export default async ({ canvas: snapshot }: Input) => {
	const canvas = createCanvasWorkerAdapter(snapshot)
	try {
		const surface = canvas.createCanvas(640, 320)
		return await surface.encode('png')
	} finally {
		await canvas.close()
	}
}
```

## 配置项与资源配额

通过 `CanvasConfig` 可配置系统层面的画布和解码配额：

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `maxWidth` | `8192` | 允许创建的最大画布宽度（像素） |
| `maxHeight` | `8192` | 允许创建的最大画布高度（像素） |
| `maxPixels` | `16,777,216` | 最大单画布像素总数（宽 × 高，约 64 MiB 显存） |
| `maxImageBytes` | `32 MiB` | 允许解码的最大单张图片文件体积 |
| `maxConcurrentDecodes` | `2` | 进程内允许并发解码的原生任务数 |
| `maxTextCharacters` | `100,000` | 单次文本排版计算允许的最大字符数 |

## 错误处理与 Result 封装

在接收用户上传图片的业务中，可捕获超出配额或格式损坏的错误并转换为业务提示：

```ts twoslash
import { Result, TaggedError } from '@pluxel/core/better-result'
import { CanvasError, type CanvasPlugin, type Image } from '@pluxel/plugin-canvas'

export class ImageRejected extends TaggedError('ImageRejected')<{
	reason: 'invalid_image' | 'too_large'
}> {}

export async function decodeUpload(
	canvas: CanvasPlugin,
	data: Uint8Array,
	signal?: AbortSignal,
): Promise<Result<Image, ImageRejected>> {
	try {
		return Result.ok(await canvas.decodeImage(data, { signal }))
	} catch (error) {
		if (error instanceof CanvasError) {
			if (error.code === 'INVALID_IMAGE') {
				return Result.err(new ImageRejected({ reason: 'invalid_image' }))
			}
			if (
				error.code === 'IMAGE_BYTES_EXCEEDED' ||
				error.code === 'DIMENSIONS_EXCEEDED' ||
				error.code === 'PIXELS_EXCEEDED'
			) {
				return Result.err(new ImageRejected({ reason: 'too_large' }))
			}
		}
		throw error
	}
}
```

---
title: 服务端 Canvas
description: 在服务端绘制位图与 SVG，解码图片，并用资源预算约束原生内存。
---

`@pluxel/canvas` 基于 `@napi-rs/canvas` 提供服务端绘图能力，包括位图 Canvas、SVG Canvas、图片解码和 Pretext 文字布局。宿主会在分配原生内存前检查资源预算，避免单个 Plugin 无限制占用内存。

`CanvasPlugin` 必须依赖 `FontsPlugin`，也为 `EChartsPlugin` 提供底层绘图能力。业务 Plugin 直接绘图时只需注入 `CanvasPlugin`。

## 安装与 catalog

```sh package-install
npx nypm add @pluxel/canvas @pluxel/fonts
```

host catalog 至少包含 `FontsPlugin`、`CanvasPlugin` 和 consumer。CanvasPlugin required-depend FontsPlugin；业务 Plugin 只需注入 Canvas：

```ts twoslash
import { CanvasPlugin, Path2D } from '@pluxel/canvas'
import { BasePlugin, Plugin } from '@pluxel/runtime'

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

```ts no-twoslash
import { CanvasPlugin } from '@pluxel/canvas'
import { FontsPlugin } from '@pluxel/fonts'
import { BadgePlugin } from '@acme/badge'

host.add([FontsPlugin, CanvasPlugin, BadgePlugin])
host.start(BadgePlugin)
await host.commit()
```

`createCanvasSync()` 返回上游 native Canvas。名称明确表示 allocation、2D context、绘图和 measure 会占用调用线程；
encode/stream 遵循上游契约，surface 由 caller 持有。重 drawing 应进入业务 worker task。

## 创建 raster 与 SVG

```ts no-twoslash
const raster = this.canvas.createCanvasSync(1200, 630)

const svg = this.canvas.createSvgCanvasSync(1200, 630, {
	mode: 'text-to-paths',
})
const svgBytes = svg.getContent()
```

`createSvgCanvasSync(width, height, options)` 支持三个互斥 mode：

- `compact`：默认，输出紧凑 SVG。
- `text-to-paths`：将文字转成 path，适合目标环境缺少字体时使用。
- `relative-paths`：使用相对 path encoding。

两种 factory 都会先检查 width、height 与总像素，并为新 context 设置当前 `FontsPlugin.defaultFont`。后续更改默认字体不会改写已有 context。

`assertDimensions(width, height)` 可在分配前复用相同校验。注意：factory 返回原生 Canvas，调用方之后仍能自行 resize；预算只保证通过 factory 发生的初始分配。

## 图片解码

```ts no-twoslash
const response = await fetchFromAnApprovedSource()
const bytes = new Uint8Array(await response.arrayBuffer())
const image = await this.canvas.decodeImage(bytes, { signal })

const surface = this.canvas.createCanvasSync(image.width, image.height)
surface.getContext('2d').drawImage(image, 0, 0)
```

`decodeImage()` 只接受已经取得的非空 `Uint8Array`。它会检查 encoded bytes，解码后再检查图片 width、height 与像素数。网络认证、重试、redirect、origin policy 和下载上限应由业务 HTTP capability 负责；Canvas 不接受 URL，也不主动 fetch。

默认 `dataOwnership: 'borrowed'`，调用方在 Promise settle 前不得修改 bytes；Canvas 在 native decode 前以 cooperative
chunk 复制输入。只有 render-local buffer 确定不再使用时才可传：

```ts no-twoslash
const image = await this.canvas.decodeImage(bytes, {
	dataOwnership: 'owned',
	signal,
})
```

`owned` 会永久移交输入 storage，避免 copy；调用后不得再次读取或修改，即使 decode abort 或失败也不会返还。native decoder 无法取消已经提交的工作，`signal` 只会停止等待并丢弃迟到结果。

CanvasPlugin root 不提供裸 Image placeholder factory；native `src` setter 无法拦截，会绕过 decode budget。图片输入使用
`decodeImage()`。

## 文字准备与 Pretext

Canvas 将 `@chenglou/pretext` 的文字准备连接到 native measurement context：

```ts no-twoslash
const prepared = this.canvas.prepareTextSync({
	text: 'A progressively wrapped paragraph',
	fontSize: 18,
	whiteSpace: 'normal',
	wordBreak: 'normal',
	letterSpacing: 0,
})

const layout = layoutWithLines(prepared, 360, 24)
```

主 API 包括：

- `prepareTextSync()`：准备普通文本。
- `prepareTextWithSegmentsSync()`：保留手动 Canvas line rendering 所需的 segment 信息。
- `prepareRichInlineSync()`：准备带独立 font、spacing、break 与 extra width 的 inline items。

省略 `font` 时使用当前 Pluxel 默认 family，可通过 `fontSize` 指定字号，默认 16px。传完整 Canvas `font` shorthand 时不能再传 `fontSize`。准备结果是不可变快照；默认字体之后发生变化，不会重写旧结果。

包根还重新导出 Pretext 的纯布局 helper，包括 `layoutWithLines()`、`layoutNextLine()`、`measureLineStats()`、`measureNaturalWidth()`、line range walkers，以及对应 rich-inline helper。准备步骤读取 native 字体；之后的布局计算是纯 arithmetic。

共享 measurement cache 会在 Fonts revision 改变或累计准备字符达到 `maxTextCacheCharacters` 时清空。

## 在 worker 中使用

native Canvas、Image 和 Plugin Context 不能 structured clone。主线程只把纯数据策略传给 worker：

```ts no-twoslash
const snapshot = this.canvas.workerSnapshot
```

`workerSnapshot` 包含：

- `limits`：width、height、pixels 和 image bytes。
- `textLimits`：text length、rich item count 与 cache budget。
- `decodeLimits`：单个 worker adapter 的 native decode concurrency 与 waiting queue。
- `font`：默认 CSS family、Fonts revision，以及非 generic family 的存在要求。

worker artifact 从独立子入口重建 adapter，不启动第二个 CanvasPlugin：

```ts no-twoslash
import { createCanvasWorkerAdapter } from '@pluxel/canvas/worker'

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

adapter 提供 `createCanvas()`、`createSvgCanvas()`、`createImage()`、`decodeImageInto()` 与 `decodeImage()`。
`createImage()` 只满足 ECharts 一类必须同步返回 placeholder 的受信任 platform contract；随后应把同一个 placeholder 与
bytes 交给 `decodeImageInto()`，它只执行一次 native decode，并在 Promise settle 前独占该 placeholder。普通调用方直接用
`decodeImage()`。直接写 native `src` 无法受 budget 约束。allocation/decode 会重新执行 host budget，decode concurrency/
queue 来自 snapshot；具体 family 若在线程 native registry 中不存在，会以 `FONT_UNAVAILABLE` 失败。adapter 拥有自己的
decode scheduler；任务结束时必须 `await close()`。close 会拒绝 queued decode、等待 already-submitted native decode
真正 settle，且不会回收已经返回给 caller 的 Canvas/Image/SVG。

只有 worker 需要 Pretext 时再引入额外子入口：

```ts no-twoslash
import { createCanvasWorkerTextLayout } from '@pluxel/canvas/worker/pretext'

const text = createCanvasWorkerTextLayout(snapshot)
const prepared = text.prepareText({ text: 'Hello', fontSize: 24 })
```

这避免 ECharts 等不使用 Pretext 的 worker artifact 承担其代码与 cache 成本。两个 worker 子入口都不提供 Plugin、Context、Workbench 或字体 mutation。

## 配置与职责

```ts no-twoslash
await host.start(CanvasPlugin, {
	catalog: [FontsPlugin],
	initialConfig: {
		maxWidth: 8192,
		maxHeight: 8192,
		maxPixels: 16_777_216,
		maxImageBytes: 32 * 1024 * 1024,
		maxConcurrentDecodes: 2,
		maxQueuedDecodes: 32,
		maxQueuedDecodesPerConsumer: 8,
		maxConcurrentDecodesPerWorkerAdapter: 1,
		maxQueuedDecodesPerWorkerAdapter: 32,
		maxTextCharacters: 100_000,
		maxRichTextItems: 2_048,
		maxTextCacheCharacters: 1_000_000,
	},
})
```

这里的 `host` 是 `createRuntimeTestHost()` fixture；`initialConfig` 只用于首次 lifecycle。后续更新使用
`host.config.patch()`，production deployment 则通过自己的 ConfigService 管理相同 record。

| 字段                                   |       默认值 | 检查对象                                      |
| -------------------------------------- | -----------: | --------------------------------------------- |
| `maxWidth`                             |       `8192` | factory 分配和 decoded image 的宽度           |
| `maxHeight`                            |       `8192` | factory 分配和 decoded image 的高度           |
| `maxPixels`                            | `16,777,216` | width × height；默认相当于 64 MiB raw RGBA    |
| `maxImageBytes`                        |     `32 MiB` | `decodeImage()` 接受的 encoded bytes          |
| `maxConcurrentDecodes`                 |          `2` | CanvasPlugin root 的在途 decode 数            |
| `maxQueuedDecodes`                     |         `32` | CanvasPlugin root 的合计等待数                |
| `maxQueuedDecodesPerConsumer`          |          `8` | 单个 caller 等待的 root decode 数             |
| `maxConcurrentDecodesPerWorkerAdapter` |          `1` | 每个 detached worker adapter 的在途 decode 数 |
| `maxQueuedDecodesPerWorkerAdapter`     |         `32` | 每个 detached worker adapter 的等待数         |
| `maxTextCharacters`                    |    `100,000` | 单次 Pretext preparation 的 UTF-16 长度       |
| `maxRichTextItems`                     |      `2,048` | 单次 rich-inline preparation 的 item 数       |
| `maxTextCacheCharacters`               |  `1,000,000` | 清空共享 measurement cache 前的累计字符预算   |

CanvasConfig 分开配置 Canvas root 与每个 worker adapter 的 native decode admission，不配置通用 worker task queue、render timeout、
output bytes、DPR 或主题：

- Worker task 的线程并发与队列由 runtime 的 root-owned `ctx.workers` 配置。
- `maxConcurrentDecodesPerWorkerAdapter` 是每个 adapter 的局部上限；ECharts 每 job 创建一个 adapter，默认 4 个
  Runtime workers × 1 个 decode，仍不是可接管 libuv 的进程级线程池。提高它会按 active worker 数产生乘法，应与
  `UV_THREADPOOL_SIZE`、其他 native work 和 RSS
  基准一起调整。
- encoded output 的格式与大小由调用方和上游 encoder 决定。
- 图表 DPR、主题与 data URL 上限由 EChartsPlugin 配置。

## 字体、Workbench 与生命周期

CanvasPlugin 使用 FontsPlugin 的默认字体，并在自己的详情页挂载统一字体选择器。字体上传、删除和持久化只属于 FontsPlugin；Workbench disabled 不影响字体恢复、Canvas 创建、解码或 worker snapshot。

Canvas 为每个 caller generation 建立 lease。consumer stop/replacement 会中止该 generation 正在等待的 decode；已返回给 caller 的 native surface 仍由 caller 自己持有，不应跨 generation 保存。

## 错误处理

`CanvasError.code` 提供稳定分类：

- lifecycle：`NOT_RUNNING`。
- surface budget：`INVALID_DIMENSIONS`、`DIMENSIONS_EXCEEDED`、`PIXELS_EXCEEDED`。
- image：`INVALID_IMAGE`、`IMAGE_BYTES_EXCEEDED`、`DECODE_BUSY`。
- text：`INVALID_TEXT`、`TEXT_TOO_LARGE`、`TEXT_LAYOUT_UNAVAILABLE`。
- worker/font：`FONT_UNAVAILABLE`、`INVALID_WORKER_SNAPSHOT`。

不要在 consumer 中捕获后放宽 host budget；应缩小输入、拒绝任务，或由 host operator 明确调整配置。

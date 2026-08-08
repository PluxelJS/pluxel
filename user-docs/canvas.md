# 服务端 Canvas

`@pluxel/canvas` 基于 [Brooooooklyn/canvas](https://github.com/Brooooooklyn/canvas) 的 Skia Node-API binding，
为 Pluxel 插件提供服务端 raster/SVG Canvas、图片解码、字体组合和宿主资源预算。

## 安装与依赖

```bash
pnpm add @pluxel/canvas @pluxel/fonts
```

Host catalog 同时放入 `FontsPlugin` 和 `CanvasPlugin`。业务插件只需把 Canvas 声明成 required dependency：

```ts
import { CanvasPlugin, Path2D } from '@pluxel/canvas'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ name: 'CardsPlugin' })
export class CardsPlugin extends BasePlugin {
	constructor(private readonly canvas: CanvasPlugin) {
		super()
	}

	async renderCard(title: string): Promise<Buffer> {
		const canvas = this.canvas.createCanvas(1200, 630)
		const context = canvas.getContext('2d')
		context.fillStyle = '#0f172a'
		context.fillRect(0, 0, canvas.width, canvas.height)
		context.font = `72px ${this.canvas.defaultFont.cssFamily}`
		context.fillStyle = '#f8fafc'
		context.fillText(title, 80, 320)

		const accent = new Path2D('M80 380 H520')
		context.strokeStyle = '#38bdf8'
		context.lineWidth = 12
		context.stroke(accent)
		return canvas.encode('png')
	}
}
```

Canvas plugin 返回原生 `@napi-rs/canvas` 对象，绘制、文本测量、同步/异步编码和 stream 继续遵循上游 API。
本包直接导出无 lifecycle 的 `Path2D`、`DOMMatrix`、`DOMPoint`、`DOMRect` 与 path enums，但不导出
`GlobalFonts`、`FontKey`、裸 Canvas constructor 或全局 cache mutation。

`createImage()` 是给 ECharts 等同步 platform callback 创建未加载 placeholder 的窄入口；不可信 bytes 仍使用
`decodeImage()`，才能应用 encoded byte 与 decoded dimension/pixel budget。

## 字体

`CanvasPlugin(FontsPlugin)` 是直接 constructor dependency。FontsPlugin 启动时自动恢复统一的 managed collection，
所以保存的字体在 headless host 中也会加载；Canvas 不拥有或复制字体集合。Workbench 启用时，Canvas 插件详情出现
Fonts selector tab：placement 和 target-scoped grant 随 Canvas 生命周期，renderer、候选字体和默认选择都来自
FontsPlugin。这个 tab 可以切换统一默认字体，但不能上传或删除；完整管理只在 FontsPlugin 页面。

每次 `createCanvas()` / `createSvgCanvas()` 都把当前 `FontsPlugin.defaultFont` 应用为 context 的初始 `10px` family。
Workbench 修改选择会影响之后创建的 context；已经返回的 native context 不会被框架隐式改写。需要其他字号时使用
`canvas.defaultFont.cssFamily`，如上例所示。

代码随包携带的静态字体可以由业务插件另外 direct-depend `FontsPlugin` 并调用 `register()` / `registerFromPath()`；这样
字体 key 会归真正的业务 consumer，而不是被错误绑定到 Canvas provider。

`createSvgCanvas(width, height, { mode })` 的 mode 是 `text-to-paths`、`compact` 或 `relative-paths`；上游 native
binding 将它们实现为互斥 enum，而不是可组合 bit flags。默认是 `compact`。

## Pretext 多行排版

Canvas 内置 `@chenglou/pretext` 的 Node measurement bridge。准备阶段通过当前 Pluxel 默认 family 和 native Canvas
测量，layout 阶段只做缓存宽度上的 arithmetic：

```ts
import { CanvasPlugin, layoutWithLines } from '@pluxel/canvas'

const prepared = this.canvas.prepareTextWithSegments({
	text: 'AGI 春天到了. بدأت الرحلة 🚀',
	fontSize: 18,
	whiteSpace: 'normal',
})
const { lines, height } = layoutWithLines(prepared, 320, 26)

for (let index = 0; index < lines.length; index += 1) {
	context.fillText(lines[index].text, 0, index * 26)
}
```

提供完整 Canvas font shorthand 时使用 `{ font: '600 18px "Brand Sans"' }`，它与 `fontSize` 互斥；省略两者时是
`16px` 加当前默认 family。`prepareText()` 适合只求 height/lineCount，`prepareTextWithSegments()` 用于手工绘制；
`prepareRichInline()` 支持不同 font、atomic mention/chip 与额外 chrome width。本包也导出 Pretext 的纯
`layout`、line range、materialize、stats 和 rich-inline walker。

默认单次文本上限 100,000 characters、rich-inline 2,048 items，共享测量 cache 每累计 1,000,000 characters 或
Fonts revision 变化时清空。Workbench 更换默认字体或动态字体 key 变化后，新 prepare 不会复用旧 font width；已经返回
的 prepared value 是 immutable snapshot。Pretext 不负责完整 CSS inline formatting、自动 hyphenation 或 mixed-bidi
逐 glyph 定位，绘制仍由调用方使用 Canvas context 完成。

## 图片输入与 outbound policy

```ts
const response = await this.http.client.url(imageUrl).get().res()
const image = await this.canvas.decodeImage(new Uint8Array(await response.arrayBuffer()), {
	signal,
})
context.drawImage(image, 0, 0)
```

`decodeImage()` 不接受 URL。下载、redirect、认证、代理、重试和 origin allowlist 应由 `@pluxel/wretch` 或业务 HTTP
client 拥有，避免 Canvas 建立第二套不一致的 outbound policy。

该方法在提交 native decode 前检查 encoded byte limit，在完成后检查 width、height 和 pixel count。上游 decoder 暂不
支持取消：`AbortSignal` 会停止本次等待并丢弃迟到结果，已经进入 native code 的工作可能继续到完成。

## 资源预算

```ts
host.cfg(CanvasPlugin).set({
	config: {
		maxWidth: 8192,
		maxHeight: 8192,
		maxPixels: 16_777_216,
		maxImageBytes: 32 * 1024 * 1024,
		maxTextCharacters: 100_000,
		maxRichTextItems: 2_048,
		maxTextCacheCharacters: 1_000_000,
	},
})
```

默认 pixel budget 对应 64 MiB raw RGBA。超出边界会在 factory 返回前抛出带稳定 `code` 的 `CanvasError`。
需要把纯数据渲染任务交给 `ctx.workers` 时，主线程传递 `canvas.workerSnapshot`，不要传 native Canvas/Image：

```ts
// plugin method
return this.ctx.workers.run(renderTask, {
	canvas: this.canvas.workerSnapshot,
	width: 1200,
	height: 630,
})

// render-worker.ts
import { createCanvasWorkerAdapter } from '@pluxel/canvas/worker'

export default async (input: RenderInput) => {
	const native = createCanvasWorkerAdapter(input.canvas)
	const canvas = native.createCanvas(input.width, input.height)
	return canvas.encode('png')
}
```

snapshot 同时包含当前 FontsPlugin 默认 family/revision 和所有 Canvas 配置上限；adapter 会在线程内重新校验分配、decode
和具体字体可用性。worker 不构造 CanvasPlugin，也没有 Workbench/Context。多行排版使用独立的
`@pluxel/canvas/worker/pretext`：

```ts
import { createCanvasWorkerTextLayout, layoutWithLines } from '@pluxel/canvas/worker/pretext'

const text = createCanvasWorkerTextLayout(input.canvas)
const prepared = text.prepareTextWithSegments({ text: input.title, fontSize: 24 })
const lines = layoutWithLines(prepared, input.width, 32)
```

Pretext 子入口复用主插件的文本/rich-inline/cache budget；不需要排版的 worker 不会打入这部分代码。
返回值是 caller-owned native object，由 GC 管理；provider stop 不会隐式销毁已经返回的 Canvas/Image。原生 Canvas 的
`width` / `height` 仍可由调用方修改，因此 factory budget 不应被误解成对后续所有原生 mutation 的代理。

部署平台必须满足上游 native package 的 support matrix。普通 Node 部署使用预编译 optional package；Lambda 等环境按
上游文档提供对应 layer，并在打包器中保持 native package external。

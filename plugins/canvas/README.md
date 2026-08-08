# @pluxel/canvas

`@pluxel/canvas` 基于 [Brooooooklyn/canvas](https://github.com/Brooooooklyn/canvas)（npm 包
`@napi-rs/canvas`）提供有宿主资源预算的服务端 Canvas capability，并把 `@pluxel/fonts` 作为 required dependency。

```ts
import { CanvasPlugin, Path2D } from '@pluxel/canvas'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ name: 'BadgePlugin' })
export class BadgePlugin extends BasePlugin {
	constructor(private readonly canvas: CanvasPlugin) {
		super()
	}

	async render(): Promise<Buffer> {
		const canvas = this.canvas.createCanvas(640, 320)
		const context = canvas.getContext('2d')
		context.fillStyle = '#111827'
		context.fillRect(0, 0, canvas.width, canvas.height)
		context.font = `48px ${this.canvas.defaultFont.cssFamily}`
		context.fillStyle = '#ffffff'
		context.fillText('Pluxel', 48, 180)

		const underline = new Path2D('M48 205 H250')
		context.lineWidth = 6
		context.stroke(underline)
		return canvas.encode('png')
	}
}
```

Host catalog 至少包含 `[FontsPlugin, CanvasPlugin, BadgePlugin]`。FontsPlugin 启动时会恢复自己统一管理的字体；Canvas
只在插件详情中挂载由 `FontsPlugin` 渲染的 selector Port tab，不拥有上传集合。Workbench disabled 不影响字体加载、
绘制或编码。selector 修改 provider 默认字体后，后续创建的 raster/SVG context 会自动使用新 family；已有 context
保持不变。上传和删除字体统一在 FontsPlugin 页面完成。

`createCanvas()` 返回上游原生 Canvas；2D context、measure、encode 和 stream API 不做二次包装。
`createImage()` 返回未加载的原生 Image，供 ECharts 这类必须同步返回 placeholder 的 platform adapter 使用；普通
图片输入仍优先使用会执行 byte/dimension budget 的 `decodeImage()`。
`createSvgCanvas()` 返回原生 SVG Canvas，`mode` 是上游三个互斥 enum variant，默认 `compact`。
`decodeImage(bytes, { signal })` 只接受已经取得的 bytes；远程下载应先通过
`@pluxel/wretch` 或领域 HTTP client 完成。

默认 factory 限制为 8192×8192、16,777,216 pixels 和 32 MiB encoded image。返回的原生 Canvas 仍允许调用方自行
resize，因此这些限制只保证通过插件 factory 发生的初始分配。native decode 无法中止；abort 会停止等待并丢弃迟到
结果，底层 decode 可能继续到完成。

`canvas.assertDimensions()` 可在分配前复用同一校验；`canvas.workerSnapshot` 返回包含 native/text limits 和当前
FontsPlugin family/revision 的纯数据快照。worker entry 不启动第二个 CanvasPlugin：

```ts
import { createCanvasWorkerAdapter } from '@pluxel/canvas/worker'

export default async ({ canvas: snapshot }: Input) => {
	const canvas = createCanvasWorkerAdapter(snapshot).createCanvas(640, 320)
	return canvas.encode('png')
}
```

adapter 在线程内创建原生 Canvas/Image/SVG、解码图片并重新执行 host budget；具体选择的已安装 family 也会在 native
registry 中验证。需要 Pretext 时单独从 `@pluxel/canvas/worker/pretext` 导入 `createCanvasWorkerTextLayout()`，避免 ECharts
等不使用 Pretext 的 artifact 承担其代码和 cache 成本。两个子入口都没有 Plugin、Context、Workbench 或字体 mutation。

Canvas 同时集成 `@chenglou/pretext` 的服务端测量桥。`prepareText()` / `prepareTextWithSegments()` /
`prepareRichInline()` 负责选择 Pluxel 默认 family、检查输入预算并在 Node 上提供 native measurement context；
`layoutWithLines()`、`measureLineStats()`、rich-inline walkers 等纯 arithmetic helper 从本包直接导出。Pretext 的共享
cache 会在字体 registry revision 改变或累计字符达到配置预算时清空，避免动态字体替换后继续复用旧宽度。

完整用户路径见 [`user-docs/canvas.md`](../../user-docs/canvas.md)，设计不变量见 [`DESIGN.md`](DESIGN.md)。

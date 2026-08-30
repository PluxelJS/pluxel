# @pluxel/canvas

`@pluxel/canvas` 基于 [Brooooooklyn/canvas](https://github.com/Brooooooklyn/canvas)（npm 包
`@napi-rs/canvas`）提供有宿主资源预算的服务端 Canvas capability，并把 `@pluxel/fonts` 作为 required dependency。

```ts
import { CanvasPlugin, Path2D } from '@pluxel/canvas'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin()
export class BadgePlugin extends BasePlugin {
	constructor(private readonly canvas: CanvasPlugin) {
		super()
	}

	async render(): Promise<Buffer> {
		const canvas = this.canvas.createCanvasSync(640, 320)
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
只在插件详情中放置由 `FontsPlugin` 渲染的 selection Attachment tab，不拥有上传集合或 consumer RPC target。Workbench disabled 不影响字体加载、
绘制或编码。selector 修改 provider 默认字体后，后续创建的 raster/SVG context 会自动使用新 family；已有 context
保持不变。上传和删除字体统一在 FontsPlugin 页面完成。

`createCanvasSync()` 返回上游原生 Canvas；`Sync` 表示 allocation 和后续 2D drawing 直接占用调用线程，context、
measure、encode 和 stream API 不做二次包装。重 drawing 应在业务 worker task 中使用 `@pluxel/canvas/worker`。
`createSvgCanvasSync()` 返回原生 SVG Canvas，`mode` 是上游三个互斥 enum variant，默认 `compact`。
`decodeImage(bytes, { signal })` 只接受已经取得的 bytes；远程下载应先通过
`@pluxel/wretch` 或领域 HTTP client 完成。
decode 默认在 Promise settle 前借用 bytes，并用 cooperative chunk 复制；render-local buffer 不再复用时可传
`dataOwnership: 'owned'` 永久移交 storage，避免输入 copy。owned 数据在 abort 或 decode failure 后也不会返还。

默认 factory 限制为 8192×8192、16,777,216 pixels 和 32 MiB encoded image。返回的原生 Canvas 仍允许调用方自行
resize，因此这些限制只保证通过插件 factory 发生的初始分配。native decode 无法中止；abort 会停止等待并丢弃迟到
结果，底层 decode 可能继续到完成。root decode 使用 owner-fair admission，默认最多 2 个在途、32 个全局等待、
每 caller 8 个等待；不可取消的 native work 真正 settle 前不会提前归还槽位。worker adapter 使用独立的
per-adapter admission，默认每个 adapter 1 个在途、32 个等待，不能把它理解成进程级 libuv 上限。

`canvas.assertDimensions()` 可在分配前复用同一校验；`canvas.workerSnapshot` 返回包含 native/text/decode limits 和当前
FontsPlugin family/revision 的纯数据快照。worker entry 不启动第二个 CanvasPlugin：

```ts
import { createCanvasWorkerAdapter } from '@pluxel/canvas/worker'

export default async ({ canvas: snapshot }: Input) => {
	const adapter = createCanvasWorkerAdapter(snapshot)
	try {
		const canvas = adapter.createCanvas(640, 320)
		return await canvas.encode('png')
	} finally {
		await adapter.close()
	}
}
```

adapter 在线程内创建原生 Canvas/Image/SVG、解码图片并重新执行 host budget；具体选择的已安装 family 也会在 native
registry 中验证。需要 Pretext 时单独从 `@pluxel/canvas/worker/pretext` 导入 `createCanvasWorkerTextLayout()`，避免 ECharts
等不使用 Pretext 的 artifact 承担其代码和 cache 成本。两个子入口都没有 Plugin、Context、Workbench 或字体 mutation。
同一线程内连续使用相同 limits/font revision 时会复用 normalized snapshot；每次调用仍创建 caller-owned adapter，
任务结束时必须 `await adapter.close()`，以拒绝排队 decode 并等待不可取消的 native decode 真正 settle。已经返回的
原生 surface 仍由调用方持有，不会被 adapter close 隐式销毁。

worker-only `createImage()` 是同步 platform adapter placeholder，不是 decode 资源边界；需要保留 placeholder identity 的
受信任 artifact 应立即调用 `decodeImageInto(image, bytes)`。它在 worker snapshot 的 concurrency/queue 内只 decode 一次，
并要求 settle 前不复用或修改 placeholder；其他调用方直接使用 `decodeImage()`。root CanvasPlugin 不暴露这个可绕过
budget 的裸 Image factory。

Canvas 同时集成 `@chenglou/pretext` 的服务端测量桥。`prepareTextSync()` / `prepareTextWithSegmentsSync()` /
`prepareRichInlineSync()` 负责选择 Pluxel 默认 family、检查输入预算并在 Node 上提供 native measurement context；
`layoutWithLines()`、`measureLineStats()`、rich-inline walkers 等纯 arithmetic helper 从本包直接导出。Pretext 的共享
cache 会在字体 registry revision 改变或累计字符达到配置预算时清空，避免动态字体替换后继续复用旧宽度。

完整用户路径见 [`docs/plugins/rendering/canvas.md`](../../../docs/plugins/rendering/canvas.md)，设计不变量见 [`DESIGN.md`](DESIGN.md)。

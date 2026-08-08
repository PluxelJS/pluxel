# 服务端 Apache ECharts

`@pluxel/echarts` 将 Apache ECharts 6 的 Canvas renderer 接到 Pluxel 的 Canvas、Fonts、caller
lifecycle、配置预算和 Workbench Port 上，适合生成报表、分享图、邮件附件和缓存图表。

## 安装与 catalog

```bash
pnpm add @pluxel/echarts @pluxel/canvas @pluxel/fonts
```

Host catalog 放入 `FontsPlugin`、`CanvasPlugin`、`EChartsPlugin` 和业务 consumer。业务插件只注入
`EChartsPlugin`：

```ts
import { EChartsPlugin } from '@pluxel/echarts'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ name: 'ReportsPlugin' })
export class ReportsPlugin extends BasePlugin {
	constructor(private readonly charts: EChartsPlugin) {
		super()
	}

	async render(signal: AbortSignal): Promise<Buffer> {
		const result = await this.charts.render({
			width: 1200,
			height: 630,
			devicePixelRatio: 2,
			signal,
			option: {
				title: { text: 'Weekly revenue' },
				xAxis: { type: 'category', data: ['Mon', 'Tue', 'Wed'] },
				yAxis: { type: 'value' },
				series: [{ type: 'line', data: [120, 200, 150] }],
			},
		})
		return result.data
	}
}
```

`render()` 返回 `{ data, mediaType, width, height, devicePixelRatio }`。默认输出 PNG；JPEG/WebP
使用 `{ output: { format, quality? } }`。logical width/height 与 DPR 相乘后的 physical canvas 仍进入
CanvasPlugin 的 dimension/pixel budget。每次调用都会在 `finally` dispose ECharts instance，不留下动画循环或
instance registry 项。

默认 `execution: 'worker'`：ECharts layout、文字测量、ZRender flush、图片 decode 与 encode 整条路径提交给 host
共享的 `ctx.workers`，不会为 ECharts 单独创建 Tinypool。宿主统一配置 thread 和 bounded queue，Canvas budget 会在主线程
无分配预检，并在线程内再次检查。worker input 使用 structured clone；formatter 函数和 native Canvas/Image 需要明确选择：

```ts
await this.charts.render({
	width: 640,
	height: 360,
	execution: 'inline',
	option: { tooltip: { formatter: (params) => formatTooltip(params) } },
})
```

inline 是兼容路径，会占用主 event loop；不会因为 clone 失败静默 fallback。默认 worker 输入无法克隆时抛出
`WORKER_INPUT_UNSUPPORTED`，shared queue 满时抛出 `RENDER_BUSY`。

## 默认字体、上传字体与 Workbench

EChartsPlugin 同时 direct-depend FontsPlugin。FontsPlugin 启动时恢复唯一的 managed font collection；即使
Workbench 关闭，保存的字体仍会在 headless host 加载。Workbench 开启时，ECharts 插件详情有 selector-only Fonts
tab，可以从 FontsPlugin 提供的系统/上传字体候选中选择 provider-wide 默认 family，但不能上传或删除。TTF、OTF、
TTC、WOFF、WOFF2 的上传和删除统一在 FontsPlugin 页面管理；字体只注册到当前 Pluxel 服务端进程，不安装到操作系统，
也不会自动下发浏览器。

每次 render 的字体优先级是：

1. option 的显式 `textStyle.fontFamily`；
2. 注册或 inline theme 的显式 `textStyle.fontFamily`；
3. 当前 `FontsPlugin.defaultFont.cssFamily`。

所以 Workbench 修改默认字体会影响后续 render；已注册主题不固化当时的默认 family。局部 label/title 等显式
font family 仍遵循 ECharts 自己的 option merge 规则。

## caller-owned 主题

```ts
const registration = this.charts.registerTheme({
	name: 'brand',
	theme: {
		color: ['#2563eb', '#14b8a6', '#f59e0b'],
		backgroundColor: '#ffffff',
		textStyle: { fontWeight: 500 },
	},
})

await this.charts.render({ width: 800, height: 400, option, theme: registration.name })
```

主题会被验证为有限深度、有限 UTF-8 byte size 的 JSON，并复制/冻结；修改调用方原对象不会反向改写 registry。
名称只在当前 caller 内唯一，不进入 ECharts 无法 unregister 的进程全局 theme table。consumer stop、replacement、
rollback 或 shutdown 会自动撤销；业务需要提前删除时调用幂等 `dispose()`。`charts.themes` 返回 detached snapshot。

`render()` 也接受 inline JSON theme，以及 ECharts 内置的 `default` / `dark` 名称；其他未注册 string 会以稳定
`THEME_NOT_FOUND` 失败，不会意外读到进程中其他库注册的全局主题。

## 图片

option 内 plain object/array 中的 data URL 会在 render 前转换为短的 render-local key，去重后交给
CanvasPlugin decode：

```ts
const result = await this.charts.render({
	width: 640,
	height: 360,
	option: {
		graphic: {
			elements: [
				{
					type: 'image',
					style: { image: logoDataUrl, width: 96, height: 96 },
				},
			],
		},
	},
})
```

HTTP(S) URL 和服务端路径不会隐式下载。远程图片先由 Wretch/领域 HTTP client 取得 bytes，再调用
`CanvasPlugin.decodeImage(bytes, { signal })`，把返回的 native Image 放入 option。这样 redirect、认证、代理、
origin allowlist、重试和取消仍由真正拥有 I/O 的 caller 决定。native Image 只适用于上述显式 inline 模式；默认 worker
模式应把取得的 bytes 转成 data URL 或使用可克隆的 option 数据。

## 配置与失败

```ts
host.cfg(EChartsPlugin).set({
	config: {
		defaultDevicePixelRatio: 1,
		maxDevicePixelRatio: 4,
		maxThemesPerConsumer: 32,
		maxThemeBytes: 1024 * 1024,
		maxDataUrlBytes: 32 * 1024 * 1024,
	},
})
```

无效输入、主题冲突/缺失、图片来源和 render failure 使用 `EChartsError.code` 分支。Canvas allocation/decode
failure 作为 `cause` 保留。Abort 会停止等待；上游 native decode/encode 已经提交后可能继续完成，结果会被丢弃。

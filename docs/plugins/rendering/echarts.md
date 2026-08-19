---
title: 服务端 Apache ECharts
description: 通过 Fonts、Canvas 和共享 Worker 在服务端渲染 Apache ECharts 6 图片。
---

# 服务端 Apache ECharts

`@pluxel/echarts` 使用 Apache ECharts 6 在服务端生成 PNG、JPEG 或 WebP 图片，适合报表、分享图、邮件附件和预生成图表。它依赖 `CanvasPlugin` 与 `FontsPlugin`，默认在线程池中完成布局、文字测量、ZRender 刷新和图片编码，避免阻塞主线程。

## 安装与 catalog

```sh package-install
npx nypm add @pluxel/echarts @pluxel/canvas @pluxel/fonts
```

host catalog 包含 `FontsPlugin`、`CanvasPlugin`、`EChartsPlugin` 与 consumer。业务 Plugin 只注入 ECharts：

```ts twoslash
import { EChartsPlugin } from '@pluxel/echarts'
import { BasePlugin, Plugin } from '@pluxel/runtime'

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

## render 输入与结果

`render()` 的核心输入是：

- `width`、`height`：正整数逻辑尺寸。
- `option`：Apache ECharts `EChartsOption`；插件只读，不修改 caller graph。
- `theme`：caller 注册的名称、内置 `default`/`dark`，或 inline JSON theme。
- `devicePixelRatio`：可选，省略时使用 ECharts config 默认值。
- `locale`、`setOption`：透传给 ECharts 的 locale 和 `setOption()` 配置。
- `output`：PNG，或带可选 quality 的 JPEG/WebP。
- `execution`：默认 `worker`，必要时显式选择 `inline`。
- `signal`：取消排队、worker execution 或 inline checkpoint。

```ts no-twoslash
const result = await this.charts.render({
	width: 800,
	height: 400,
	devicePixelRatio: 2,
	option,
	output: { format: 'webp', quality: 85 },
	signal,
})

result.data // Buffer
result.mediaType // 'image/webp'
result.width // 800
result.height // 400
result.devicePixelRatio // 2
```

PNG 是默认格式且不接受 `quality`；JPEG/WebP quality 必须在 0 到 100。返回尺寸是逻辑尺寸，实际 surface 按 `ceil(width × DPR)` 与 `ceil(height × DPR)` 创建，因此仍受 Canvas 尺寸和总像素预算约束。

## worker 与 inline execution

默认 `execution: 'worker'`。EChartsPlugin 将只读 option 的 structured clone、Canvas `workerSnapshot` 和 render policy 交给 root-owned `ctx.workers`：

1. worker 从 snapshot 构造 bounded Canvas adapter。
2. ECharts 以 SSR mode 初始化。
3. 等待受支持的 render-local 图片、flush 并编码。
4. 在 `finally` 中 dispose ECharts instance。

worker concurrency、每 owner 队列和 host 总队列均由 runtime workers 配置，不是 EChartsConfig 或 CanvasConfig 字段。队列满时抛出 `EChartsError`，code 为 `RENDER_BUSY`。

worker option 必须可 structured clone。formatter function、native Image 等对象无法穿过边界；确有需要时显式使用：

```ts no-twoslash
await this.charts.render({
	width: 800,
	height: 400,
	option: optionWithFormatterFunction,
	execution: 'inline',
})
```

inline mode 支持 function 与 native object，但会占用主事件循环，且仍执行 Canvas dimensions/image budgets。不要把 inline 当作默认性能路径。

## caller-owned theme

```ts no-twoslash
const theme = this.charts.registerTheme({
	name: 'reports',
	theme: {
		color: ['#2563eb', '#16a34a'],
		backgroundColor: '#fff',
	},
})

await this.charts.render({
	width: 800,
	height: 400,
	option,
	theme: theme.name,
})

theme.dispose()
```

`registerTheme()` 接受 plain JSON object，深度复制并冻结。函数、class instance、cycle、非有限 number 或过深结构会被拒绝。返回 registration 提供 `name`、`active` 与幂等的 `dispose()`。

主题名称与 registration 归属于当前 caller generation：

- 不同 caller 可使用相同 local name。
- 同一 caller 重复名称得到 `THEME_CONFLICT`。
- consumer stop/replacement 自动撤销全部 registration。
- `charts.themes` 返回当前 caller 的只读 `{ name, byteLength }` snapshot。

这些主题不会写进 ECharts process-global `registerTheme()` 表，因为上游没有 unregister API。`default` 和 `dark` 是可直接使用的内置名称；也可在单次 render 中传 inline JSON theme。

## 默认字体

当 option 与 theme 都没有提供 `textStyle.fontFamily` 时，每次 render 会注入当前 `FontsPlugin.defaultFont.cssFamily`。内置 `default`/`dark` theme 也会在 option 层补入默认字体。

因此 Workbench 改变 Fonts 默认选择后，后续 render 自动使用新 family；不需要重新注册 theme。`charts.defaultFont` 可读取当前 provider 默认字体。

EChartsPlugin 的详情页使用 FontsPlugin 提供的统一字体选择器。字体上传、删除、持久化和 native registration 只属于 FontsPlugin。

## 图片来源 policy

worker mode 支持 ECharts image 字段中的 data URL。插件只重写明确的图片位置，包括普通 `image` 字段和 `image://data:` source；普通文本里恰好以 `data:` 开头的字符串不会被当成图片。

data URL 在 ZRender 前被替换为 render-local key，并通过 Canvas worker adapter 解码，因此同时受到两层限制：

- ECharts `maxDataUrlBytes`：base64 解码前的 source 上限。
- Canvas `maxImageBytes`、width、height 与 pixels：实际图片解码上限。

HTTP(S) URL 与服务端文件路径会被拒绝。ECharts/Canvas 不应隐式拥有网络、认证、redirect、proxy 或文件读取权限。先通过业务 outbound HTTP capability 获取 bytes；若需要把 native Image 放进 option，则用 `CanvasPlugin.decodeImage()` 解码并选择 `execution: 'inline'`。

## 配置与职责

```ts no-twoslash
host.cfg(EChartsPlugin).set({
	defaultDevicePixelRatio: 1,
	maxDevicePixelRatio: 4,
	maxThemesPerConsumer: 32,
	maxThemeBytes: 1024 * 1024,
	maxDataUrlBytes: 32 * 1024 * 1024,
})
```

| 字段                      |   默认值 | 职责                                               |
| ------------------------- | -------: | -------------------------------------------------- |
| `defaultDevicePixelRatio` |      `1` | render 未传 DPR 时使用的值                         |
| `maxDevicePixelRatio`     |      `4` | 单次 render 可请求的 DPR 上限                      |
| `maxThemesPerConsumer`    |     `32` | 一个 caller 同时注册的 named theme 数              |
| `maxThemeBytes`           |  `1 MiB` | 一个 registered 或 inline JSON theme 的 UTF-8 上限 |
| `maxDataUrlBytes`         | `32 MiB` | ECharts image data URL 的 pre-decode 上限          |

`defaultDevicePixelRatio` 不能高于 `maxDevicePixelRatio`。字体由 FontsPlugin 配置，尺寸、总像素和 decoded image bytes 由 CanvasPlugin 配置，worker 并发与队列由 runtime `ctx.workers` 配置，网络访问策略由业务 HTTP capability 配置。EChartsConfig 只拥有 DPR、theme 和 ECharts data URL 限制。

## 错误处理

`render()`、theme registration 与 lifecycle 错误使用 `EChartsError`。稳定 code 包括：

- lifecycle/input：`NOT_RUNNING`、`INVALID_INPUT`。
- theme：`INVALID_THEME`、`THEME_TOO_LARGE`、`THEME_LIMIT_EXCEEDED`、`THEME_CONFLICT`、`THEME_NOT_FOUND`。
- image：`INVALID_IMAGE_SOURCE`、`IMAGE_SOURCE_TOO_LARGE`、`UNSUPPORTED_IMAGE_SOURCE`、`IMAGE_LOAD_FAILED`。
- execution：`WORKER_INPUT_UNSUPPORTED`、`RENDER_BUSY`、`RENDER_FAILED`。

Canvas dimensions/pixels 校验发生在 render 前；底层 Canvas failure 最终作为带 cause 的 render failure 暴露。业务层应按 code 决定拒绝、降级或重试，不要解析 message，也不要通过切换 inline 绕过资源预算。

---
title: 服务端 Apache ECharts
description: 通过 Fonts、Canvas 和共享 Worker 在服务端渲染 Apache ECharts 6 图片。
---

`@pluxel/echarts` 使用 Apache ECharts 6 在服务端生成 PNG、JPEG 或 WebP 图片，适合报表、分享图、邮件附件和预生成图表。它依赖 `CanvasPlugin` 与 `FontsPlugin`，只在线程池中完成布局、文字测量、ZRender 刷新和图片编码，避免把同步 ECharts 渲染放到主线程。

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

```ts no-twoslash
import { CanvasPlugin } from '@pluxel/canvas'
import { EChartsPlugin } from '@pluxel/echarts'
import { FontsPlugin } from '@pluxel/fonts'
import { ReportsPlugin } from '@acme/reports'

host.add([FontsPlugin, CanvasPlugin, EChartsPlugin, ReportsPlugin])
host.start(ReportsPlugin)
await host.commit()
```

## render 输入与结果

`render()` 的核心输入是：

- `width`、`height`：正整数逻辑尺寸。
- `option`：declarative Apache ECharts `EChartsOption`；render settle 前不得修改 caller graph。
- `theme`：caller 注册的名称、内置 `default`/`dark`，或 inline JSON theme。
- `devicePixelRatio`：可选，省略时使用 ECharts config 默认值。
- `locale`、`setOption`：透传给 ECharts 的 locale 和 `setOption()` 配置。
- `output`：PNG，或带可选 quality 的 JPEG/WebP。
- `signal`：取消排队或 worker execution。

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

## Worker-only execution

EChartsPlugin 先用 `ctx.workers.runPrepared()` 取得 root-owned shared queue 的 fair execution slot，再 cooperative 检查
borrowed option 并组装 Canvas `workerSnapshot` 与 render policy。queue full 不先遍历 graph；borrowed input 省略重复
snapshot，真正 dispatch 时仍由 worker transport 建立私有 graph：

1. worker 从 snapshot 构造 bounded Canvas adapter。
2. ECharts 以 SSR mode 初始化。
3. 等待受支持的 render-local 图片、flush 并编码。
4. 在 `finally` 中撤销 render-local image scope、等待其 JS task settle、dispose ECharts instance，并关闭 Canvas adapter；
   adapter close 会等 already-submitted native decode 真正 settle 后才让 worker handler 返回。

Worker task concurrency、每 owner 队列和 host 总队列均由 runtime workers 配置，不是 EChartsConfig 或 CanvasConfig 字段；
每个 adapter 内的 image decode admission 则来自 CanvasConfig。队列满时抛出 `EChartsError`，code 为 `RENDER_BUSY`。

option 必须由 plain object、array、typed array 和 scalar data 组成。formatter function、accessor、native/class object 和
SharedArrayBuffer 都会以 `WORKER_INPUT_UNSUPPORTED` 拒绝，不存在 inline fallback。admission 后、worker transport 前会同时检查 option 的
estimated bytes、value count 与 nesting depth；遍历每 2,048 个 value 让出一次 event loop，单个大字符串也按 64 Ki
characters 分片计量。真正的 worker transport
serialization 仍发生在宿主线程，因此 Worker-only 表示重 layout/render 已隔离，不表示主线程成本为零。三项预算把这段
不可避免的 serialization 成本限制在 host 可配置上界内；`setOption` policy 也计入同一预算并使用相同 declarative contract。

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

- ECharts `maxDataUrlBytes`：单张图片 base64/percent decode 后的 source bytes 上限。
- ECharts `maxImages` / `maxTotalImageBytes`：单次 render 的 distinct source 数与 decoded source bytes 总量。
- ECharts `maxTotalImagePixels`：所有图片完成 native decode 后的总像素数。
- Canvas `maxImageBytes`、width、height 与 pixels：实际图片解码上限。

ECharts 的同步 placeholder 会直接交给 Canvas `decodeImageInto()`；每个 distinct source 只做一次 native decode，不会先生成
第二个 Image 再触发 `src` setter 重复解码。Canvas decode queue 满时映射为 ECharts `RENDER_BUSY`。

Canvas worker adapter 默认每次只提交 1 个 native decode；Runtime 默认最多运行 4 个 worker，因此 ECharts 默认最多贡献
4 个同时在途的 Canvas decode，而不是形成 4 × 4 的嵌套并行。这个 admission 只协调 Pluxel 自己提交的工作，不能接管
进程共享 libuv pool。图片失败会中止同一次 render 尚未开始的 decode；已提交的 native work 不可抢占，worker handler
会等待它真实完成，再把线程用于下一 job。

HTTP(S) URL 与服务端文件路径会被拒绝。ECharts/Canvas 不应隐式拥有网络、认证、redirect、proxy 或文件读取权限。
先通过业务 outbound HTTP capability 获取 bytes，再转换成受支持的 data URL；native Image 不能进入 declarative option。

## 配置与职责

```ts no-twoslash
await host.start(EChartsPlugin, {
	catalog: [FontsPlugin, CanvasPlugin],
	initialConfig: {
		defaultDevicePixelRatio: 1,
		maxDevicePixelRatio: 4,
		maxThemesPerConsumer: 32,
		maxTotalThemes: 256,
		maxTotalThemeBytes: 16 * 1024 * 1024,
		maxThemeBytes: 1024 * 1024,
		maxThemeNodes: 20_000,
		maxThemeDepth: 64,
		maxDataUrlBytes: 32 * 1024 * 1024,
		maxImages: 32,
		maxTotalImageBytes: 32 * 1024 * 1024,
		maxTotalImagePixels: 16_777_216,
		maxOptionBytes: 8 * 1024 * 1024,
		maxOptionNodes: 100_000,
		maxOptionDepth: 64,
		maxOutputBytes: 64 * 1024 * 1024,
	},
})
```

这里的 `host` 是 `createRuntimeTestHost()` fixture；`initialConfig` 只用于首次 lifecycle。后续更新使用
`host.config.patch()`，production deployment 则通过自己的 ConfigService 管理相同 record。

| 字段                      |    默认值 | 职责                                               |
| ------------------------- | --------: | -------------------------------------------------- |
| `defaultDevicePixelRatio` |       `1` | render 未传 DPR 时使用的值                         |
| `maxDevicePixelRatio`     |       `4` | 单次 render 可请求的 DPR 上限                      |
| `maxThemesPerConsumer`    |      `32` | 一个 caller 同时注册的 named theme 数              |
| `maxTotalThemes`          |     `256` | 此 Plugin node 保留的 named theme 总数             |
| `maxTotalThemeBytes`      |  `16 MiB` | 所有 retained named theme 的合计 JSON bytes        |
| `maxThemeBytes`           |   `1 MiB` | 一个 registered 或 inline JSON theme 的 UTF-8 上限 |
| `maxThemeNodes`           |  `20,000` | 一个 theme 的 value 数上限                         |
| `maxThemeDepth`           |      `64` | 一个 theme 的 object/array nesting 上限            |
| `maxDataUrlBytes`         |  `32 MiB` | 单张 data URL decoded source bytes 上限            |
| `maxImages`               |      `32` | 单次 render 的 distinct image source 数            |
| `maxTotalImageBytes`      |  `32 MiB` | 单次 render 的 decoded image source bytes 总量     |
| `maxTotalImagePixels`     |  `16.8 M` | 单次 render decoded pixels；约 64 MiB raw RGBA     |
| `maxOptionBytes`          |   `8 MiB` | option structured-clone payload 的估算上限         |
| `maxOptionNodes`          | `100,000` | option 遍历的 value 数上限                         |
| `maxOptionDepth`          |      `64` | option object/array nesting 上限                   |
| `maxOutputBytes`          |  `64 MiB` | worker 返回前的 encoded raster 上限                |

`defaultDevicePixelRatio` 不能高于 `maxDevicePixelRatio`。字体由 FontsPlugin 配置，单张图片的 native dimensions/pixels 与
encoded bytes 由 CanvasPlugin 配置，worker 并发与队列由 runtime `ctx.workers` 配置，网络访问策略由业务 HTTP capability
配置。EChartsConfig 拥有 DPR、theme、option/data URL transport、每次 render 的图片累计预算与 output 限制。

默认单次 render 的 root surface 与 decoded images 各最多约 64 MiB raw RGBA。encoded source、output、ECharts/Skia
结构和解码时的临时 allocation 仍会增加 RSS；聚合像素检查也只能发生在一张图片 decode 完成后，不能撤销已发生的 native
allocation。高并发 host 应联合测量 `workers.maxThreads`、Canvas per-worker decode admission、`UV_THREADPOOL_SIZE` 与 peak RSS，
不要把任一局部上限当成进程总内存保证。

## 错误处理

`render()`、theme registration 与 lifecycle 错误使用 `EChartsError`。稳定 code 包括：

- lifecycle/input：`NOT_RUNNING`、`INVALID_INPUT`、`OPTION_TOO_LARGE`。
- theme：`INVALID_THEME`、`THEME_TOO_LARGE`、`THEME_LIMIT_EXCEEDED`、`THEME_CONFLICT`、`THEME_NOT_FOUND`。
- image：`INVALID_IMAGE_SOURCE`、`IMAGE_SOURCE_TOO_LARGE`、`UNSUPPORTED_IMAGE_SOURCE`、`IMAGE_LOAD_FAILED`。
- execution：`WORKER_INPUT_UNSUPPORTED`、`OUTPUT_TOO_LARGE`、`RENDER_BUSY`、`RENDER_FAILED`。

Canvas dimensions/pixels 校验发生在 render 前；底层 Canvas failure 最终作为带 cause 的 render failure 暴露。业务层应按 code 决定拒绝、降级或重试，不要解析 message。

---
title: Takumi JSX / HTML 图片渲染
description: 使用原生 Takumi API 或共享 Worker，将 JSX、HTML 与 node tree 渲染为图片、SVG 和动画。
---

`@pluxel/takumi` 将 `takumi-js` 的渲染能力接入 Plugin 依赖图。业务渲染优先使用共享 Worker：HTML / node tree 调用 `*InWorker()`，React / HeroUI 在业务 task 内构建。以下原生方法保留上游的输入、选项、返回值和异常，供需要在当前 realm 执行的调用方使用：

| 方法                         | 返回值                               |
| ---------------------------- | ------------------------------------ |
| `render(input, options?)`    | 图片 bytes，`Buffer` 或 `Uint8Array` |
| `renderSvg(input, options?)` | SVG string                           |
| `renderAnimation(options)`   | 动画 bytes，`Buffer` 或 `Uint8Array` |

输入可以是 React JSX、HTML string 或 Takumi node tree。尺寸、格式、字体、CSS、图片加载和取消均通过上游 options 提供；完整参数见 [Takumi 文档](https://takumi.kane.tw/docs/)。

需要隔离 HTML、CSS 与输入准备时，使用同一个 Plugin 的 `renderInWorker(input, options?)`、`renderSvgInWorker(input, options?)`
或 `renderAnimationInWorker(options)`。这三个方法只接受可结构化克隆的 HTML / node tree 与选项；React JSX 在业务自己的 Worker task 中构建。

## 安装和装配

以下命令在快速开始生成的工作区根目录执行；按 [添加插件](../index.md#把一个插件加入应用) 选择直接使用依赖的包，再运行 `vp install`。

```sh
vp exec pluxel pncat add @pluxel/takumi
```

Host catalog 包含 Takumi 和 consumer，并安装 Workers 与 NodeModules 服务。业务 Plugin 只声明自己使用的能力：

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { TakumiPlugin } from '@pluxel/takumi'

@Plugin()
export class SocialCardsPlugin extends BasePlugin {
	constructor(private readonly takumi: TakumiPlugin) {
		super()
	}

	renderCard(title: string, signal?: AbortSignal) {
		return this.takumi.renderInWorker(
			{
				type: 'container',
				style: {
					display: 'flex',
					width: '100%',
					height: '100%',
					alignItems: 'center',
					justifyContent: 'center',
					backgroundColor: '#1d4ed8',
					color: 'white',
				},
				children: [{ type: 'text', text: title, style: { fontSize: 64 } }],
			},
			{ width: 1200, height: 630, format: 'webp', quality: 88, signal },
		)
	}
}
```

将 `await renderCard('项目报告')` 的返回值直接保存为 `.webp`，应能看到居中的标题与蓝色背景。HTML 模板中的动态文本和属性由模板作者按位置转义；node tree 的 `text` 字段适合直接传普通文本。

## HTML / node tree 放入共享 Worker

Host 安装已有的 [Workers 服务](../../plugin-development/node-artifacts.md#选择安装能力)；`standardServices()` 与 `servicesPreset()` 已包含它。
调用方可以直接提交 HTML 或 node tree，无需声明自己的 task：

```ts no-twoslash
const png = await this.takumi.renderInWorker('<h1 class="title">项目报告</h1>', {
	width: 1200,
	height: 630,
	css: '.title { font-size: 72px; color: #0f766e; }',
	fonts: [{ name: 'Report Sans', data: fontBytes }],
	format: 'png',
	signal,
})
```

`renderInWorker` 与 `renderAnimationInWorker` 返回 `Uint8Array`，`renderSvgInWorker` 返回 SVG string。字体与图片使用 bytes，CSS 使用编译好的 string 或原生声明对象；函数 loader、自定义 `fetch`、`allowUrl` callback、Renderer instance、React 元素与 WASM module 不跨线程。

Worker 图片选项接受预加载 sources，或包含 `sources`、`timeout`、`maxBytes`、`cache`、`allowRemote` 的对象。`allowRemote` 默认允许远程加载；需要只用本地准备的资源时显式设为 `false`。请求级 signal 用于共享队列与运行中任务的取消。

`*InWorker()` 在任务接纳时 snapshot 输入，调用后可以复用原来的对象和 bytes。它不提供 transfer 或 borrowed 模式；这些低层选项属于自行声明的业务 task。

## 直接使用 React 和 HeroUI v3

模板文件使用 `.tsx`，让应用工具链编译 JSX。Takumi 在同一 JavaScript realm 解析组件与服务端 Hooks，再调用原生 renderer；无需启动浏览器或调用 `react-dom/server`。

HeroUI v3 组件可以直接作为 JSX 输入。应用在构建时编译 Tailwind v4 与 `@heroui/styles`，启动时读取生成的 CSS，然后通过 `css` 传入：

```tsx no-twoslash
import { Card } from '@heroui/react'

// css 是应用加载的编译结果；fonts 是应用准备的字体 bytes。
return this.takumi.render(
	<Card className="w-full h-full">
		<Card.Header>
			<Card.Title>项目报告</Card.Title>
			<Card.Description>2026 年度经营分析</Card.Description>
		</Card.Header>
		<Card.Content>已完成本季度目标。</Card.Content>
	</Card>,
	{ width: 1200, height: 630, css, fonts, format: 'png', signal },
)
```

CSS 入口按 HeroUI 的顺序导入，并把模板加入 Tailwind source：

```css
@import 'tailwindcss';
@import '@heroui/styles';
@source './report-card.tsx';
```

组件执行与 CSS 支持要分别验证。静态卡片可用的结果不能证明 Select、Popover 等浏览器交互组件也兼容；检查输出中的字体、间距、颜色与裁切。组件安装和样式构建由消费插件负责，参见 [HeroUI 文档](https://www.heroui.com/docs/react/getting-started/quick-start)。

仓库的 ReportStudio 已直接渲染 HeroUI `Card`、`Chip` 与 `Button`，可参考完整的 [JSX 模板](https://github.com/PluxelJS/pluxel/blob/main/projects/plugin-host/src/showcase/report-card.tsx)、[CSS 入口](https://github.com/PluxelJS/pluxel/blob/main/projects/plugin-host/src/showcase/report-card.css) 和[构建脚本](https://github.com/PluxelJS/pluxel/blob/main/projects/plugin-host/scripts/compile-report-card-css.mjs)。该 CSS 入口只导入所用组件及基础主题，编译结果作为 string 供应用加载。

需要把组件执行也放入 Worker 时，在业务包中声明普通 task，并只传标题、CSS、字体 bytes 等业务数据。在 Plugin 模块顶层声明 task：

```ts no-twoslash
import { Workers, defineWorkerTask } from '@pluxel/services/workers'
import type { Font } from '@pluxel/takumi'

const cardTask = defineWorkerTask<{ title: string; css: string; fonts: Font[] }, Uint8Array>(
	import.meta.url,
	'./report-card-worker.tsx',
)

// 放在业务 Plugin 的方法中；任务使用宿主已有的共享线程池。
return this.ctx.require(Workers).run(
	cardTask,
	{ title, css, fonts },
	{
		signal,
		settlement: 'execution',
	},
)
```

同目录的 `report-card-worker.tsx` 在 Worker 内构建真正的 HeroUI JSX，并导入 worker adapter：

```tsx no-twoslash
import { Card } from '@heroui/react'
import type { Font } from '@pluxel/takumi'
import { render } from '@pluxel/takumi/worker'

export default function renderCard({
	title,
	css,
	fonts,
}: {
	title: string
	css: string
	fonts: Font[]
}) {
	return render(
		<Card className="w-full h-full">
			<Card.Header>
				<Card.Title>{title}</Card.Title>
			</Card.Header>
			<Card.Content>已完成本季度目标。</Card.Content>
		</Card>,
		{ width: 1200, height: 630, css, fonts, format: 'png' },
	)
}
```

`@pluxel/takumi/worker` 提供 `render`、`renderSvg`、`renderAnimation` 与对应的 `LocalRenderOptions`、`LocalSvgRenderOptions`、`LocalAnimationOptions`。它接受当前线程内的 JSX、JSX options 与图片加载 callback；字体仍只接受具体 bytes，样式使用 `css`，`renderer` 与 `module` 由 adapter 管理。业务 task、React、组件与 JSX resolver 位于同一 bundle。无需 `new Worker()` 或创建线程池。

在线程内调用这些函数时，输入、options 与字体/图片 bytes 在 Promise settle 前保持不变。保留缓存拥有自己的字体副本，调用完成后可以复用原始 bytes。

## 字体与图片由调用方提供

Takumi 使用原生 `fonts`。例如在 consumer 初始化时读取随包字体，并在每次调用中传入：

```ts no-twoslash
const fontData = await readFile(new URL('./assets/BrandSans.woff2', import.meta.url))

const image = await this.takumi.render('<h1 class="title">Brand</h1>', {
	width: 1200,
	height: 630,
	fonts: [{ name: 'Brand Sans', data: fontData }],
	css: '.title { font-family: "Brand Sans"; font-size: 72px; }',
})
```

`readFile` 来自 `node:fs/promises`。中文模板需要包含对应字形的字体。需要统一管理上传字体或可移植字体资源时，consumer 可以另行依赖 [FontsPlugin](./fonts.md#何时直接使用-fontsplugin)，读取 bytes 后交给 `fonts`。

图片同样沿用上游 `images`，可以提供预加载 bytes，也可以使用上游的 fetch/cache 选项：

```ts no-twoslash
await this.takumi.render('<img src="https://assets.example/logo.png">', {
	width: 1200,
	height: 630,
	images: [{ src: 'https://assets.example/logo.png', data: logoBytes }],
	signal,
})
```

需要出站认证、来源限制或应用缓存时，由 consumer 准备资源或提供相应的上游加载选项。

## Renderer 与缓存

原生入口沿用 Takumi 的默认共享 Renderer。上游会复用字体注册、图片解码与 parsed CSS；字体 bytes 应在初始化时准备并复用，反复创建新 `Buffer` 会错过按对象身份建立的字体注册缓存。原生入口需要独立缓存设置时，可按上游契约传入自己的 `renderer`。

官方 `*InWorker()` task 与业务 task 的 `/worker` adapter 使用同一套线程内缓存。Renderer 按 backend identity 与完整字体集的内容、metadata 分组，避免不同文档的同名 family 相互覆盖。缓存对 Renderer 数量、累计字体源 bytes 与每个 Renderer 的图片/CSS资源分别设限；过大的字体集只使用本任务的临时 Renderer，不进入保留缓存。上限由 [worker runtime 常量](https://github.com/PluxelJS/pluxel/blob/main/plugins/render/takumi/src/renderer-cache.ts) 维护；字体源 bytes 上限不等于解压字体、活动渲染与输出的总内存上限。

缓存属于一个存活 Worker。共享线程池没有 task affinity，同一输入可能落到另一个线程；取消、idle retirement 或 Host 关闭也会清除对应线程缓存。不同 Worker 仍拥有各自的 Renderer；同一 native binary 的 glyph cache 由上游在进程内共享。图片下载 bytes、解码图片与最终输出是不同的缓存边界，不能用解码缓存代替 HTTP 或业务产物缓存。

## 执行位置、取消与失败

Node 下的 raster/SVG 核心渲染使用上游 N-API async work；原生入口的 JSX 组件执行、HTML 解析、冷 CSS 准备与 N-API 输入转换仍在调用它的 realm。返回 Promise 不代表整条链路已经离开主线程。

Worker 入口隔离这些准备工作，native raster/SVG 仍占进程共享 libuv 线程池；Worker 数量不会增加 native 线程池容量。React 函数不能跨线程，因此任意 JSX 使用原生入口，固定模板则在业务 Worker 内构建。

原生入口的 `signal` 与异常保持上游契约；`*InWorker()` 使用共享 Workers 的 queue、取消与 `WorkerTaskError` 契约，并固定等待 execution settlement。运行中取消终止该 Worker，底层 native work 无法立即抢占；方法等待线程退出确认后 settle，runtime 在此之前保留执行 slot。Plugin stop/replacement 会取消对应 owner 已接纳的 Worker 任务。所有 Plugin 方法仍受 Core generation 门禁约束，详见 [Worker 取消与 Plugin stop](../../plugin-development/node-artifacts.md#取消与-plugin-stop)。

## Markdown 与 Typst

需要 GFM、表格、代码高亮或受限数学公式时，使用 [Markdown / Typst](./takumi-markdown.md)。它负责 Markdown 转换，并提交一次最终 Worker render；可用的 Typst provider 自动提供公式能力。完整 Typst 文档、Vector 预览与 PDF 使用独立的 [TypstPlugin](./typst.md)。

---
title: Markdown / Typst 图片渲染
description: 使用 GFM、静态代码高亮与可选 Typst 数学，通过共享 Worker 将 Markdown 渲染为图片或 SVG。
---

`@pluxel/plugin-takumi-markdown` 负责 Markdown 文档转换：解析 GFM、排版 table、静态高亮 code fence，再通过 `TakumiPlugin` 提交一次最终 Worker render。它适合 release note、说明文档、报告与需要静态快照的 Markdown 内容。

| 需求                                               | 选择                             |
| -------------------------------------------------- | -------------------------------- |
| Markdown 文档、GFM table、代码块、图片             | `@pluxel/plugin-takumi-markdown` |
| React JSX、HeroUI 卡片、HTML 或 node tree          | [Takumi](./takumi.md)            |
| 已有 rows/columns 的静态报告表，需精确 Canvas 绘制 | [Canvas table](./canvas.md)      |
| 完整 Typst 文档、Vector 预览或 PDF                 | 工作区 [TypstPlugin](./typst.md) |

Markdown table 由 Takumi 的 HTML/CSS layout 排版。可用的工作区 `TypstPlugin` 自动为 Markdown 提供受限公式编译。

## 安装与最小装配

以下命令在快速开始生成的工作区根目录执行；按 [添加插件](../index.md#把一个插件加入应用) 选择直接使用依赖的包，再运行 `vp install`。

```sh
vp exec pluxel pncat add @pluxel/plugin-takumi-markdown @pluxel/plugin-takumi
```

Host catalog 包含 Takumi、Markdown 和 consumer，并安装共享 [Workers 服务](../../plugin-development/node-artifacts.md#选择安装能力)。`standardServices()` 与 `servicesPreset()` 已包含该服务。MarkdownPlugin required-depend Takumi；业务 Plugin 只注入直接使用的 Markdown capability：

```ts no-twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import { TakumiMarkdownPlugin, type MarkdownRenderer } from '@pluxel/plugin-takumi-markdown'

@Plugin()
export class ReleaseImagePlugin extends BasePlugin {
	private renderer!: MarkdownRenderer

	constructor(private readonly markdown: TakumiMarkdownPlugin) {
		super()
	}

	override init(): void {
		this.renderer = this.markdown.createRenderer({ theme: 'light' })
	}

	renderReleaseNotes(source: string, signal?: AbortSignal) {
		return this.renderer.render(source, {
			width: 1200,
			height: 630,
			format: 'webp',
			quality: 88,
			signal,
		})
	}
}
```

`createRenderer({ extensions?, theme? })` 保存当前插件这一轮运行的扩展列表和默认主题。插件停止或被替换时，renderer 自动关闭；需要提前结束时调用 `await renderer.close()`。

`render(source, options?)` 直接返回图片 bytes；`renderSvg(source, options?)` 直接返回 SVG string。将 `await renderReleaseNotes('# 1.0.0\n\n首次发布')` 保存为 `.webp`，应能看到标题与正文。

转换和扩展执行期间仍会读取 options 及其字体/图片 bytes；在返回的 Promise settle 前保持它们不变。`assets.add()` 只借用输入 bytes 到该次 `add()` settle，随后由本次 render 拥有副本。

## 上游选项与文档主题

`MarkdownRenderOptions` 与 `MarkdownSvgRenderOptions` 分别沿用 Takumi 的 `WorkerRenderOptions` 与 `WorkerSvgRenderOptions`，另加单次文档的 `theme`。宽高、字体、DPR、CSS、图片、格式和取消使用对应字段：

```ts no-twoslash
const png = await this.renderer.render('# 月度报告', {
	width: 1200,
	height: 630,
	theme: 'dark',
	fonts: [{ name: 'Report Sans', data: fontBytes }],
	css: 'article { font-family: "Report Sans"; }',
	format: 'png',
	signal,
})

const svg = await this.renderer.renderSvg('# 月度报告', {
	width: 1200,
	height: 630,
	fonts: [{ name: 'Report Sans', data: fontBytes }],
	signal,
})
```

单次调用的 `theme` 覆盖 `createRenderer()` 的默认主题；两处都省略时使用 `light`。

自定义 `css` 在内置文档与高亮样式之后应用。字体使用具体 bytes；需要中文时提供覆盖相应字形的字体。函数 loader、fetch callback、Renderer 与 WASM module 不跨线程，样式使用 `css`。Worker options、缓存与执行边界见 [Takumi](./takumi.md)。

## GFM、表格、代码块与图片

GFM 固定开启，包括 table、task list、strike-through 和 footnote。Raw HTML 固定关闭，并在所有 HAST extension pass 后移除；请求中的 HTML 标签不会作为原始 HTML 输出。

Fence code 使用 Rangi 的 classes-only HTML 和内置 light/dark CSS。语言名称按固定 alias mapping 转换，未知语言按 plain code 显示；高亮器和语言集合由插件固定。

Markdown 图片使用标准语法。默认只消费预加载资源，consumer 将 bytes 与原始图片 URL 一起交给 `images`：

```ts no-twoslash
await this.renderer.render('![Logo](https://assets.example/logo.png)', {
	width: 1200,
	height: 630,
	images: [{ src: 'https://assets.example/logo.png', data: logoBytes }],
})
```

若文档需要网络图片，显式设置 `images.allowRemote: true`。超时、下载 bytes 上限与解码 cache 使用同一个可跨线程的对象：

```ts no-twoslash
await this.renderer.render('![Logo](https://assets.example/logo.png)', {
	width: 1200,
	height: 630,
	images: {
		allowRemote: true,
		timeout: 5_000,
		maxBytes: 2 * 1024 * 1024,
	},
})
```

## 工作区可选的 Typst 数学

`@pluxel/plugin-typst` 目前是 workspace-only 能力，只能在包含该包的源码工作区中集成；公开包状态见 [Package 与入口矩阵](../../reference/package-matrix.md#workspace-only-能力)。普通 Markdown 不要求安装 Typst。此可选 peer 不承诺 npm 版本，也不会自动安装私有 provider。

在 Host catalog 中加入 FontsPlugin 和 TypstPlugin，并运行 Typst provider 后，Markdown 自动启用内置数学能力。业务插件仍只注入 `TakumiMarkdownPlugin`，沿用前面的 `createRenderer()` 与调用方式：

```ts no-twoslash
const png = await this.renderer.render('$x^2 + y^2 = z^2$', {
	width: 1200,
	height: 630,
	format: 'png',
})
```

没有运行中的 Typst provider 时，内容按普通 Markdown 处理。provider 出现、撤回或替换会触发 Markdown 与下游重启；旧 renderer 失效，业务在新一轮 `init()` 中创建 renderer。

公式支持 inline math 和 display math block，只接受受限 math expression：字母、数字、数学符号、空白、分组和表达式标点可用；command、反斜杠、字符串、path、import/include/read、image、plugin 等在编译前拒绝。

内置数学层为公式构造固定 Typst 文档，并调用 `TypstPlugin.renderSvg(source, options)`。字体、native compiler 与编译 Worker 都由 TypstPlugin 负责；Markdown 只拥有公式校验、公式/SVG 容量和资产接线。生成的 SVG bytes 进入同一次最终 Takumi Worker render。

公式 SVG 使用透明背景和当前 `theme` 对应的内置正文前景色。Inline 与 display 公式按各自模式编译，display 公式居中；SVG viewBox 的 point 尺寸换算为 CSS pixel 后写入图片宽高。

完整 Typst 文件、package、页面、模板和会话使用 [Typst 文档](./typst.md)，不通过数学表达式入口传入。

## 自定义受信任 Markdown 扩展

`createRenderer({ extensions })` 是受信任的 startup-time composition。不要从 Markdown request、用户配置或数据库记录直接接受可执行 extension declaration。

每次 render 按 array 顺序执行一次 extension factory。它可以请求有限的 Satteri feature、返回 MDAST/HAST plugins，或通过 context 的 `assets.add()` 加入 PNG/JPEG/WebP/SVG bytes。

`MarkdownExtensionContext.theme` 是本次调用解析后的 `light` 或 `dark`，扩展可用它生成与文档主题一致的资产。

Asset sink 分配 opaque internal source、复制 bytes，并检查 count/per-asset/total limits。Extension 不能选择资产 URL，也不能在本次 render settle 后继续使用 sink。需要保留资源或独立生命周期时，建立自己的 Plugin capability。

## 文档限额、取消与失败

`TakumiMarkdownConfig` 只配置文档自身的容量：source、AST、生成 HTML、扩展资产、代码块与公式。通过 [Host env/file 绑定](../../host/configuration.md#绑定部署环境与-json-文件) 提供它与 `configs.use()` 使用的同一 schema；配置变更后重启插件，env/file 变更后重建 Host。

默认最多 1 MiB source、20,000 个 AST nodes、1 MiB generated HTML、16 个 extensions、32 个 generated assets（单个 1 MiB、合计 8 MiB）、64 个 code blocks（单个 128 KiB、合计 512 KiB）。同一个 `TakumiMarkdownConfig` 的 `math` 配置默认最多 32 个公式、每个 4,096 characters、每个 SVG 1 MiB、每次文档 SVG 合计 4 MiB。

GFM、代码高亮与受信任 extension 在调用 realm 执行；大文本检查与资产 copy 在 checkpoint 让出 event loop。最终 HTML、CSS 和图片准备及 raster/SVG render 进入共享 Worker。公式编译完成后释放其 Typst Worker slot，再提交最终 Takumi task，不在一个 slot 内等待第二个共享 task。

`signal` 用于文档转换 checkpoint、extension、Typst 编译与最终 Worker task；renderer 的 `close()` abort 本 handle 的任务并等待它们 settle。Takumi task 使用 execution settlement，因此取消时会等待线程退出确认；底层 native work 不能立即抢占。

`MarkdownError` 描述文档自己能判定的失败，例如 `MARKDOWN_TOO_LARGE`、`AST_LIMIT_EXCEEDED`、`HTML_TOO_LARGE`、`CODE_LIMIT_EXCEEDED`、资产超限和已关闭 handle。公式失败使用同一个错误类的 `FORMULA_INVALID`、`FORMULA_TOO_LARGE`、`FORMULA_COMPILE_FAILED` 与 `SVG_TOO_LARGE`，已知 Typst 编译/容量失败保留 cause。未知扩展、Typst 及共享 Workers 失败继续 reject，consumer 按能恢复的具体契约处理。

## 将可恢复失败交给业务调用方

文档预览可以提示用户缩短过大的 Markdown，因此 consumer 只把 `MARKDOWN_TOO_LARGE` 转成领域 Err。这里的 renderer 由 owning Plugin 创建和清理：

```ts no-twoslash
import { Result, TaggedError } from '@pluxel/core/better-result'
import {
	MarkdownError,
	type MarkdownRenderer,
	type MarkdownRenderOptions,
} from '@pluxel/plugin-takumi-markdown'

export class DocumentTooLarge extends TaggedError('DocumentTooLarge')<{ message: string }> {}

export async function renderDocument(
	renderer: MarkdownRenderer,
	source: string,
	options?: MarkdownRenderOptions,
): Promise<Result<Uint8Array, DocumentTooLarge>> {
	try {
		return Result.ok(await renderer.render(source, options))
	} catch (error) {
		if (error instanceof MarkdownError && error.code === 'MARKDOWN_TOO_LARGE') {
			return Result.err(new DocumentTooLarge({ message: 'Shorten the Markdown document.' }))
		}
		throw error
	}
}
```

Err 时提示缩短文档，Ok 时直接使用 bytes。启用内置数学后，consumer 还可以按 `MarkdownError.code` 将 `FORMULA_INVALID` 或 `FORMULA_TOO_LARGE` 转成修正公式的提示；未处理的编译失败、未知扩展错误与取消继续 reject。

[可执行示例](https://github.com/PluxelJS/pluxel/blob/main/plugins/render/takumi-markdown/tests/fixtures/result-consumer.ts)与[回归测试](https://github.com/PluxelJS/pluxel/blob/main/plugins/render/takumi-markdown/tests/markdown.test.ts)。

---
title: Markdown / Typst 图片渲染
description: 使用 GFM、固定静态代码高亮和可选受限 Typst 数学，将 Markdown 有界地渲染为 Takumi 图片或 SVG。
---

@pluxel/takumi-markdown 把 Markdown 文档变成图片：它在取得 Takumi 的 render
admission 后再解析 GFM、处理 table、固定高亮 code fence，最后只做一次 Takumi render。它适合
release note、说明文档、报告、社交卡片或需要稳定静态快照的 Markdown 内容。

先按输出的真实模型选择能力：

| 需求                                               | 选择                    |
| -------------------------------------------------- | ----------------------- |
| Markdown 文档、GFM table、代码块、图片             | @pluxel/takumi-markdown |
| 已有 rows/columns 的静态报告表，需精确 Canvas 绘制 | @pluxel/canvas/table    |
| 折线、柱状、饼图、坐标轴等图表                     | @pluxel/echarts         |

Markdown table 由 Takumi 的 HTML/CSS layout 排版，不重复调用 Canvas table；图表仍交给 ECharts。

## 安装与最小装配

以下命令在快速开始生成的工作区根目录执行；按 [添加插件](../index.md#把一个插件加入应用) 选择直接使用依赖的包，再运行 `pnpm install`。

```sh
pnpm catalog:add -- @pluxel/takumi-markdown @pluxel/takumi @pluxel/fonts
```

host catalog 包含 Fonts、Takumi、Markdown 和 consumer。MarkdownPlugin 已 required-depend Takumi，
Takumi 又 required-depend Fonts；业务 Plugin 只注入直接使用的 Markdown capability：

```ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { TakumiMarkdownPlugin, type MarkdownRenderer } from '@pluxel/takumi-markdown'

@Plugin()
export class ReleaseImagePlugin extends BasePlugin {
	private renderer!: MarkdownRenderer

	constructor(private readonly markdown: TakumiMarkdownPlugin) {
		super()
	}

	override init(): void {
		this.renderer = this.markdown.createRenderer({ theme: 'light' })
	}

	renderReleaseNotes(markdown: string, signal?: AbortSignal) {
		return this.renderer.render({
			markdown,
			width: 1200,
			height: 630,
			output: { format: 'webp', quality: 88 },
			signal,
		})
	}
}
```

`createRenderer()` 保存当前插件这一轮运行所需的扩展列表和默认主题。插件停止或被替换时，返回的 renderer 自动关闭；需要提前结束时调用 `await renderer.close()`。

调用 `renderReleaseNotes('# 1.0.0\n\n首次发布')` 后，将返回值的 `data` 保存为 `.webp`，应能看到标题与正文。需要 SVG 时调用 `renderSvg()`，并省略 `devicePixelRatio` 和 raster `output`。

## GFM、表格与代码块

GFM 固定开启，包括 table、task list、strike-through 和 footnote。每个 Markdown table 变成
Takumi HTML/CSS table；它不是可排序/分页的数据网格，也不使用 @pluxel/canvas/table。

Raw HTML 固定关闭，并在所有 HAST extension pass 后移除。因此 request 中的
&lt;img&gt;、&lt;script&gt; 或任意 HTML 不会作为 HTML 输出。Markdown 图片仍可使用标准 Markdown
syntax；若 image URL 是 HTTP(S) 或内存 source，先由业务 HTTP capability 取得 bytes，然后用完全相同的
src 填入 images：

```ts
await this.renderer.render({
	markdown: '![Logo](https://assets.example/logo.png)',
	images: [{ src: 'https://assets.example/logo.png', data: logoBytes }],
	width: 1200,
	height: 630,
})
```

Fence code 使用 Rangi 的 classes-only HTML 和内置 light/dark CSS。语言名称按固定 alias mapping
转换，未知语言按 plain code 显示；没有 Shiki grammar/theme 下载、自动语言检测或按 request 选择高亮器。
可继续用 stylesheets 为本次文档加自己的 CSS，但内容、stylesheets 与 image bytes 在 render Promise
settle 前都按 Takumi borrowed contract 保持不变。

## 可选的 Typst 数学

需要普通 inline/display math 时，额外安装 Typst extension：

```sh
pnpm catalog:add -- @pluxel/takumi-markdown-typst
```

catalog 再加入 TypstMathPlugin，consumer 注入它并把 extension 交给 renderer：

```ts
import { TypstMathPlugin } from '@pluxel/takumi-markdown-typst'

constructor(
	private readonly markdown: TakumiMarkdownPlugin,
	private readonly typst: TypstMathPlugin,
) {
	super()
}

override init(): void {
	this.renderer = this.markdown.createRenderer({
		extensions: [this.typst.createMarkdownExtension()],
	})
}
```

随后文档可写 $x^2 + y^2 = z^2$ 或 display math block。这个能力只接受受限 math
expression：普通字母、数字、数学符号、空白、分组和表达式标点可用；# command、反斜杠、
字符串、path、import/include/read、image、plugin 等会在编译前拒绝。

它不是通用 Typst document compiler：不能传 main file、package、font、页面选项、网络 source 或外部 input；
也不支持 MDX。每个公式在 Runtime shared Worker 生成 SVG asset，再进入这一次最终 Takumi render，
不会创建内嵌 renderer。

## 自定义受信任 Markdown 扩展

createRenderer({ extensions }) 是受信任的 startup-time composition，不要把 extension declaration
从 Markdown request、用户配置或数据库记录直接接收。每个 extension factory 只会在 render 已被 Takumi
admit 后执行，并按 array 顺序运行一次；它可以请求有限的 Satteri feature、返回 MDAST/HAST plugins，
或通过 context 的 assets.add() 加入 PNG/JPEG/WebP/SVG bytes。

asset sink 分配 opaque internal source、copy bytes 并执行 count/per-asset/total limits。extension 不能选 URL、
不能让 renderer fetch、也不能在本次 render settle 后继续使用 sink。若需要保留资源或独立生命周期，应建立自己的
Plugin capability，而不是捕获该 render-local sink。

## 限额、取消与错误

MarkdownPlugin 的默认值为：1 MiB source、20,000 个 AST nodes、1 MiB generated HTML、16 个 trusted
extensions、32 个 generated assets（单个 1 MiB、合计 8 MiB）、64 个 code blocks（单个 128 KiB、合计
512 KiB）。Typst extension 默认最多 32 个公式、每个 4,096 characters、每个 SVG 1 MiB、每次文档合计
4 MiB。两层还受 Takumi 的 dimension、pixel、content/style/image、output、deadline 和 fair queue policy
约束；host config 是上限，不会被 request 放宽。

signal 取消排队、cooperative source/tree/asset preparation、Worker formula task 和尚未开始的 native
render。已进入 Takumi native work 的计算不能强制抢占；caller 立即收到取消，但 admission capacity 会等真实
native settlement 后才释放。

可按稳定 error code 分支：

- MarkdownError：MARKDOWN_TOO_LARGE、AST_LIMIT_EXCEEDED、HTML_TOO_LARGE、
  CODE_LIMIT_EXCEEDED、asset limit、EXTENSION_FAILED、NOT_RUNNING。
- TypstMathError：FORMULA_INVALID、FORMULA_TOO_LARGE、FORMULA_COMPILE_FAILED、
  SVG_TOO_LARGE、NOT_RUNNING。
- TakumiError：例如 RENDER_BUSY、RENDER_TIMEOUT、PIXELS_EXCEEDED、
  IMAGE_BYTES_EXCEEDED 和 OUTPUT_TOO_LARGE。

缩小输入、延后任务或由 host operator 明确调整 config；consumer 不应捕获错误后自行绕过 host
budget。Takumi 的字体、remote image loading、render output 与 native cancellation 细节见
[Takumi HTML 图片渲染](./takumi.md)。

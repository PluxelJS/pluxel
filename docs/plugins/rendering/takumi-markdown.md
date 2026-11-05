---
title: Markdown / Typst 图片渲染
description: 使用 GFM、静态代码高亮与可选 Typst 数学，通过共享 Worker 将 Markdown 渲染为图片或 SVG。
---

`@pluxel/plugin-takumi-markdown` 负责将 Markdown 文档转化为图片或 SVG 矢量图。它支持完整的 GFM 语法（表格、任务列表等）、内置轻量代码高亮，并可通过 `TakumiPlugin` 将排版与渲染流程调度到 Worker 线程池中执行。非常适合自动生成版本发布公告（Release Notes）、图文长图与社交分享卡片。

## 安装与装配

在工作区中添加依赖：

```sh
vp exec pluxel pncat add @pluxel/plugin-takumi-markdown @pluxel/plugin-takumi
```

在插件中创建渲染器并渲染 Markdown 文档：

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

- `createRenderer({ theme, extensions })` 创建一个与当前插件生命周期绑定的渲染器实例。
- `renderer.render(source, options)` 返回图片的二进制数据（`Uint8Array`）。
- `renderer.renderSvg(source, options)` 返回 SVG 文本字符串。

## 样式与主题选项

`MarkdownRenderOptions` 支持指定画布尺寸、明暗主题、自定义字体与附加 CSS：

```ts no-twoslash
const png = await this.renderer.render('# 月度运营总结', {
	width: 1200,
	height: 630,
	theme: 'dark', // 'light' | 'dark'
	fonts: [{ name: 'Report Sans', data: fontBytes }],
	css: 'article { font-family: "Report Sans"; line-height: 1.6; }',
	format: 'png',
	signal,
})
```

## GFM 语法与代码高亮

- 自动支持 GitHub Flavored Markdown 规范，包括表格、代码围栏（Code Fence）、任务列表和删除线。
- 代码块内置基于 Rangi 的静态高亮，支持绝大多数主流编程语言，并与文档主题（浅色/深色）自适应适配。
- 为保证服务端渲染安全，原生 HTML 标签会被自动过滤。

## 图片资源加载

Markdown 中的图片既可使用预加载的二进制数据，也可允许远程下载：

```ts no-twoslash
// 方式一：使用预加载图片
await this.renderer.render('![Logo](https://assets.example.com/logo.png)', {
	width: 1200,
	height: 630,
	images: [{ src: 'https://assets.example.com/logo.png', data: logoBytes }],
})

// 方式二：允许受限的远程抓取
await this.renderer.render('![Logo](https://assets.example.com/logo.png)', {
	width: 1200,
	height: 630,
	images: {
		allowRemote: true,
		timeout: 5_000,
		maxBytes: 2 * 1024 * 1024,
	},
})
```

<span id="可选的-typst-数学"></span>
<span id="工作区可选的-typst-数学"></span>

## 可选的 Typst 数学公式支持

如果宿主同时装配了工作区内的 `@pluxel/plugin-typst` 插件，Markdown 渲染器会自动激活数学公式扩展，支持行内公式（`$E=mc^2$`）与独立行公式（`$$...$$`）：

```ts no-twoslash
const png = await this.renderer.render(
	'爱因斯坦质能方程：$E = m c^2$\n\n高斯积分：\n\n$$ \\int_{-\\infty}^\\infty e^{-x^2} dx = \\sqrt{\\pi} $$',
	{
		width: 1200,
		height: 630,
		format: 'png',
	},
)
```

- 公式会由 Typst 编译器自动渲染为精美、矢量的 SVG 并内嵌到最终图片中。
- 公式渲染使用透明背景，前景色自动适配当前文档的浅色/深色主题。

## 自定义文档扩展

可通过 `createRenderer({ extensions })` 传入受信任的扩展逻辑，用于自定义 AST 转换或注入动态生成的图表/贴图资源：

```ts no-twoslash
const renderer = this.markdown.createRenderer({
	extensions: [
		{
			name: 'custom-badge',
			transform(ctx) {
				// 可操作 MDAST / HAST 树或向 ctx.assets 注册临时图片资产
			},
		},
	],
})
```

## 错误处理与 Result 封装

在处理来自用户输入的 Markdown 内容时，可以捕获超出尺寸上限的错误并向前端返回友好的提示：

```ts twoslash
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
			return Result.err(new DocumentTooLarge({ message: '文档字符数超出限制，请适当精简' }))
		}
		throw error
	}
}
```

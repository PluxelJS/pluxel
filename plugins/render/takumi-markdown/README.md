# @pluxel/takumi-markdown

@pluxel/takumi-markdown renders a bounded GFM Markdown document to a Takumi PNG, JPEG,
WebP, or SVG. It is the document-oriented layer above @pluxel/takumi: acquire one Takumi
admission slot, parse Markdown and apply fixed code highlighting, then perform one final native
render.

Use it for document screenshots, release notes, reports, and social cards that start as Markdown.
Use @pluxel/canvas/table for a programmatically assembled static report table, and
@pluxel/echarts for charts; this package deliberately does not reproduce either layout engine.

```ts
import { TakumiMarkdownPlugin, type MarkdownRenderer } from '@pluxel/takumi-markdown'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin()
export class DocumentImagePlugin extends BasePlugin {
	private renderer!: MarkdownRenderer

	constructor(private readonly markdown: TakumiMarkdownPlugin) {
		super()
	}

	override init(): void {
		this.renderer = this.markdown.createRenderer({ theme: 'light' })
	}

	render(markdown: string, signal?: AbortSignal) {
		return this.renderer.render({
			markdown,
			width: 1200,
			height: 630,
			signal,
		})
	}
}
```

The caller-generation-owned renderer is closed automatically when its consumer stops or is
replaced. Call close() yourself when a handle has a shorter lifetime.

GFM is always enabled, including tables. Raw HTML is disabled and removed after trusted HAST
extensions run. Fenced code uses the fixed, classes-only Rangi mapping and built-in light/dark
stylesheet; unsupported fence names render as plain code. There is no Shiki grammar download,
theme selection, language autodetection, MDX evaluation, network fetch, or browser runtime.

Extensions are trusted startup-time composition, not request data. Each extension factory runs
after Takumi admission, once per accepted document and in renderer-array order. It can request a
small fixed set of Satteri parser features and add generated PNG/JPEG/WebP/SVG bytes through its
per-render asset sink. The sink chooses opaque internal sources, copies its data under limits, and
stops accepting assets when that render settles.

For optional restricted Typst math, add @pluxel/takumi-markdown-typst and pass
typst.createMarkdownExtension() to createRenderer(). The user-facing guide is
[docs/plugins/rendering/takumi-markdown.md](../../../docs/plugins/rendering/takumi-markdown.md);
[DESIGN.md](DESIGN.md) records execution and ownership boundaries.

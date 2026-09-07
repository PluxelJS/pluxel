# @pluxel/takumi-markdown-typst

@pluxel/takumi-markdown-typst is an optional @pluxel/takumi-markdown extension for
small inline and display math. It compiles each accepted formula in the Runtime shared Worker,
adds the resulting SVG through the Markdown render's asset sink, and lets the already-reserved
Takumi render lay it out once.

It intentionally does not expose a general Typst document compiler.

```ts
import { TypstMathPlugin } from '@pluxel/takumi-markdown-typst'
import { TakumiMarkdownPlugin, type MarkdownRenderer } from '@pluxel/takumi-markdown'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin()
export class MathDocumentPlugin extends BasePlugin {
	private renderer!: MarkdownRenderer

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
}
```

The extension enables Satteri math and accepts a deliberately small formula dialect: ordinary
letters, numbers, math symbols, whitespace, grouping and common expression punctuation. It rejects
code escapes, # commands, strings, backslashes, paths, imports, reads, images, plugins and
dynamic Typst APIs before the compiler runs. Callers cannot select a Typst main file, package,
font, page setup, network source, or compiler option.

Each formula is subject to count, character, per-SVG and total-SVG limits. Cancellation stops the
shared Worker task through the normal Runtime worker lifecycle; generated SVG bytes are copied only
into the active Markdown render. The final native Takumi work remains governed by the parent
reservation's cancellation semantics.

See [the Markdown / Typst guide](../../../docs/plugins/rendering/takumi-markdown.md) for installation
and user-facing limits, and [DESIGN.md](DESIGN.md) for the worker and trust boundary.

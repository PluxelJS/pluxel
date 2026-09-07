import { BasePlugin, Plugin } from '@pluxel/runtime'
import { TakumiMarkdownPlugin, type MarkdownRenderer } from '@pluxel/takumi-markdown'
import { TypstMathError, TypstMathPlugin } from '../../src/index.ts'

/** Test-only dynamic fixture. It stays outside package source and is never exported by the Plugin. */
@Plugin()
export class TypstDynamicProbePlugin extends BasePlugin {
	private renderer!: MarkdownRenderer

	constructor(
		private readonly markdown: TakumiMarkdownPlugin,
		private readonly typst: TypstMathPlugin,
	) {
		super()
	}

	protected override init(): void {
		this.renderer = this.markdown.createRenderer({
			extensions: [this.typst.createMarkdownExtension()],
		})
		this.ctx.elysia
			.get('/__pluxel-test/typst/render', () => this.render())
			.get('/__pluxel-test/typst/error/unsafe', () => this.unsafeFormula())
	}

	private async render(): Promise<Response> {
		const result = await this.renderer.render({
			markdown: 'Inline $x^2 + y^2 = z^2$ and display:\n\n$$sum_(i=1)^n i$$',
			width: 640,
			height: 320,
		})
		return new Response(Uint8Array.from(result.data).buffer, {
			headers: { 'content-type': result.mediaType },
		})
	}

	private async unsafeFormula(): Promise<Response> {
		try {
			await this.renderer.render({
				markdown: '$#let unsafe = 1$',
				width: 64,
				height: 32,
			})
			return Response.json({ code: 'UNEXPECTED_SUCCESS' }, { status: 500 })
		} catch (error) {
			return Response.json({
				code: error instanceof TypstMathError ? error.code : 'UNEXPECTED_ERROR',
			})
		}
	}
}

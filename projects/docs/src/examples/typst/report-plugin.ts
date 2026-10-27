import { BasePlugin, Plugin } from '@pluxel/core'
import { TypstPlugin } from '@pluxel/plugin-typst/wasm'
import type { ExampleRequest, ExampleResponse } from './protocol'
import { generateExample } from './generate'
import { ThemePlugin } from './theme-plugin'

let generations = 0

function send(message: ExampleResponse) {
	postMessage(message)
}

@Plugin()
export class ReportPlugin extends BasePlugin {
	private readonly generation = ++generations
	constructor(
		private readonly typst: TypstPlugin,
		private readonly theme: ThemePlugin,
	) {
		super()
	}

	override init() {
		const listener = (event: MessageEvent<ExampleRequest>) => {
			if (event.data.type !== 'compile') return
			void this.compile(event.data)
		}
		addEventListener('message', listener)
		this.ctx.effects.defer(() => {
			removeEventListener('message', listener)
			send({
				type: 'lifecycle',
				message: `ReportPlugin #${this.generation} 已停止，消息订阅已释放。`,
			})
		})
		send({
			type: 'lifecycle',
			message: `ReportPlugin #${this.generation} 已启动，TypstPlugin / ThemePlugin 依赖已注入。`,
		})
	}

	private async compile(request: Extract<ExampleRequest, { type: 'compile' }>) {
		try {
			const started = performance.now()
			const generated = generateExample(request)
			const svg = await this.typst.renderSvg(`${this.theme.preamble()}\n${request.source}`, {
				files: generated.files,
			})
			const text = new TextDecoder().decode(svg)
			send({
				type: 'compiled',
				revision: request.revision,
				svg: text,
				blocks: generated.blocks.filter((block) =>
					text.includes(`xlink:href="pluxel:preview/${block.id}"`),
				),
				durationMs: Math.round(performance.now() - started),
				theme: this.theme.version,
				generation: this.generation,
			})
		} catch (error) {
			const diagnostics =
				error instanceof Error && 'diagnostics' in error ? error.diagnostics : undefined
			send({
				type: 'error',
				message: `${error instanceof Error ? error.message : String(error)}${diagnostics ? `\n${JSON.stringify(diagnostics, null, 2)}` : ''}`,
				fatal: false,
				revision: request.revision,
			})
		}
	}
}

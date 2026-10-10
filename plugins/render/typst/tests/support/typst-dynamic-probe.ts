import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ElysiaApp } from '@pluxel/services/elysia'
import { BasePlugin, Plugin } from '@pluxel/core'
import { TypstPlugin } from '../../src/index.ts'

@Plugin()
export class TypstDynamicProbePlugin extends BasePlugin {
	constructor(private readonly typst: TypstPlugin) {
		super()
	}

	protected override init(): void {
		this.ctx.require(ElysiaApp).get('/__pluxel-test/typst/document', () => this.render())
	}

	private async render(): Promise<Response> {
		const root = await mkdtemp(join(tmpdir(), 'typst-dynamic-'))
		try {
			await writeFile(
				join(root, 'main.typ'),
				'#let a = json("/inputs/a.json")\n#let b = json("/inputs/b.json")\n#assert(a.n + b.n == 3)\nReport',
			)
			await using session = await this.typst.open({ root, entry: 'main.typ' })
			const compiled = await session.update({
				files: {
					'/inputs/a.json': { kind: 'json', value: { n: 1 } },
					'/inputs/b.json': { kind: 'json', value: { n: 2 } },
				},
			})
			if (!compiled.preview.data.byteLength) throw new Error('Missing Vector output')
			const pdf = await session.exportPdf(compiled.revision)
			return new Response(Uint8Array.from(pdf).buffer, {
				headers: { 'content-type': 'application/pdf' },
			})
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	}
}

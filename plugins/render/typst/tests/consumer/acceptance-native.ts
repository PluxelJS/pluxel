import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BasePlugin, Plugin } from '@pluxel/core'
import { TypstError, TypstPlugin } from '@pluxel/plugin-typst'

export const job = JSON.parse(await readFile(new URL('./job.json', import.meta.url), 'utf8')) as {
	roots: string[]
	font: string
	evidence: string
}
@Plugin()
export class ArtifactConsumer extends BasePlugin {
	constructor(readonly typst: TypstPlugin) {
		super()
	}
	async init() {
		await using session = await this.typst.open({ root: job.roots[0]!, entry: 'main.typ' })
		const receipts: unknown[] = []
		let lastSuccessfulRevision = 0
		for (const [index, root] of job.roots.entries()) {
			let compileMs = 0
			try {
				const started = performance.now()
				const compiled = await session
					.update({ template: { root, entry: 'main.typ' }, files: {} })
					.finally(() => {
						compileMs = +(performance.now() - started).toFixed(3)
					})
				const pdf = await session.exportPdf(compiled.revision)
				const png = await session.renderPage({ revision: compiled.revision, page: 1, scale: 1.25 })
				assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), '%PDF-')
				assert.equal(Buffer.from(png.data).subarray(1, 4).toString(), 'PNG')
				await writeFile(join(job.evidence, `native-${index}.pdf`), pdf)
				await writeFile(join(job.evidence, `native-${index}.png`), png.data)
				await writeFile(
					join(job.evidence, `navigation-${index}.json`),
					JSON.stringify(compiled.preview.navigation, null, 2),
				)
				lastSuccessfulRevision = compiled.revision
				receipts.push({
					ok: true,
					compileMs,
					sessionId: session.id,
					revision: compiled.revision,
					pdfBytes: pdf.length,
					diagnostics: compiled.diagnostics,
				})
			} catch (cause) {
				if (!(cause instanceof TypstError)) throw cause
				receipts.push({
					ok: false,
					compileMs,
					sessionId: session.id,
					lastSuccessfulRevision,
					code: cause.code,
					diagnostics: cause.diagnostics,
				})
			}
		}
		await writeFile(join(job.evidence, 'native.json'), JSON.stringify(receipts, null, 2))
	}
}

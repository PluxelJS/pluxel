import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BasePlugin, Plugin } from '@pluxel/core'
import { TypstPlugin, TypstError } from '@pluxel/plugin-typst'
import * as v from 'valibot'

/** The host injects the compiler. Every requested source revision shares one session. */
@Plugin()
export class ReportRenderPlugin extends BasePlugin {
	readonly config = this.configs.use(v.object({ job: v.string(), entry: v.string() }))
	constructor(readonly typst: TypstPlugin) {
		super()
	}
	async init() {
		const { job, entry } = this.config
		const requests: { root: string; sourceRevision: string }[] = JSON.parse(
			await readFile(join(job, 'requests.json'), 'utf8'),
		)
		if (requests.length === 0) throw new Error('No source snapshots supplied')
		await using session = await this.typst.open({ root: requests[0]!.root, entry })
		const receipts: unknown[] = []
		let lastSuccessfulRevision: number | undefined
		for (const [index, request] of requests.entries()) {
			const destination = join(job, `render-${index + 1}`)
			await mkdir(destination)
			try {
				// Both are complete replacements: no hidden input table and no stale template files.
				const compiled = await session.update({
					template: { root: request.root, entry },
					files: {},
				})
				const pdf = await session.exportPdf(compiled.revision)
				const image = await session.renderPage({ revision: compiled.revision, page: 1, scale: 1.5 })
				await writeFile(join(destination, 'report.pdf'), pdf)
				await writeFile(join(destination, 'page-1.png'), image.data)
				await writeFile(
					join(destination, 'navigation.json'),
					JSON.stringify(compiled.preview.navigation, null, 2),
				)
				lastSuccessfulRevision = compiled.revision
				receipts.push({
					ok: true,
					sourceRevision: request.sourceRevision,
					sessionId: session.id,
					revision: compiled.revision,
					pages: compiled.preview.navigation.pages.length,
					pdfBytes: pdf.byteLength,
					diagnostics: compiled.diagnostics,
				})
			} catch (error) {
				if (!(error instanceof TypstError)) throw error
				receipts.push({
					ok: false,
					sourceRevision: request.sourceRevision,
					sessionId: session.id,
					lastSuccessfulRevision,
					code: error.code,
					message: error.message,
					diagnostics: error.diagnostics,
				})
			}
		}
		await writeFile(join(job, 'compile.json'), JSON.stringify(receipts, null, 2))
	}
}

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BasePlugin, Plugin } from '@pluxel/core'
import { TypstPlugin, type TypstFiles } from '@pluxel/plugin-typst'
import * as v from 'valibot'

/** One-shot consumer: compilation uses constructor injection and the public session API. */
@Plugin()
export class ReportRenderPlugin extends BasePlugin {
	readonly config = this.configs.use(v.object({ job: v.string() }))
	constructor(readonly typst: TypstPlugin) {
		super()
	}
	async init() {
		const job = this.config.job
		const files: TypstFiles = JSON.parse(await readFile(join(job, 'inputs.json'), 'utf8'))
		await using session = await this.typst.open({ root: join(job, 'template'), entry: 'main.typ' })
		const compiled = await session.update({ files })
		const pdf = await session.exportPdf(compiled.revision)
		const image = await session.renderPage({ revision: compiled.revision, page: 1, scale: 1.5 })
		await writeFile(join(job, 'report.pdf'), pdf)
		await writeFile(join(job, 'page-1.png'), image.data)
		await writeFile(
			join(job, 'compile.json'),
			JSON.stringify(
				{
					revision: compiled.revision,
					pages: compiled.preview.navigation.pages.length,
					pdfBytes: pdf.byteLength,
					diagnostics: compiled.diagnostics,
				},
				null,
				2,
			),
		)
	}
}

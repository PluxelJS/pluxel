import { resolve } from 'node:path'
import {
	accepted,
	check,
	checkout,
	commit,
	initialize,
	openWorkspace,
	render,
	ReportError,
} from './workspace.ts'

const [command, argument, extra, label] = process.argv.slice(2)
const started = performance.now()
try {
	if (!argument)
		throw new Error(
			'Usage: report init <new-directory> | copy <directory> <new-directory> | check <directory> | render <directory> [output-directory] | rename-label <directory> <old> <new>',
		)
	const directory = resolve(argument)
	let result: unknown
	if (command === 'init') {
		const created = await initialize(directory)
		result = { directory, diskRevision: created.diskRevision }
	} else if (command === 'copy' && extra) {
		const copied = await checkout(directory, resolve(extra))
		result = { directory: copied.directory, diskRevision: copied.diskRevision }
	} else if (command === 'check') {
		result = await check(directory)
		if (!(result as { valid: boolean }).valid) process.exitCode = 1
	} else if (command === 'rename-label' && extra && label) {
		const current = await openWorkspace(directory)
		const edited = accepted(
			current.project.renameLabel({
				baseRevision: current.project.revision,
				from: extra,
				to: label,
			}),
		)
		result = await commit(directory, { baseRevision: current.diskRevision, files: edited.files })
	} else if (command === 'render') {
		const fonts: unknown = JSON.parse(process.env.TYPST_FONT_FILES ?? '[]')
		if (
			!Array.isArray(fonts) ||
			fonts.length === 0 ||
			fonts.some((font) => typeof font !== 'string')
		)
			throw new Error('Set TYPST_FONT_FILES to a JSON array of explicit font paths.')
		result = await render(directory, fonts, extra)
		if ((result as { results: { ok: boolean }[] }).results.some((item) => !item.ok))
			process.exitCode = 1
	} else throw new Error('Unknown command or missing arguments')
	console.log(
		JSON.stringify(
			{ ...(result as object), elapsedMs: Math.round(performance.now() - started) },
			null,
			2,
		),
	)
} catch (error) {
	console.error(
		JSON.stringify(
			error instanceof ReportError
				? { ok: false, issues: error.issues }
				: {
						ok: false,
						message: String(error),
						cause: error instanceof Error ? error.cause : undefined,
					},
			null,
			2,
		),
	)
	process.exitCode = 1
}

import { resolve } from 'node:path'
import { initialize, checkout, prepare, apply, render, ReportError } from './workspace.ts'

const root = resolve(import.meta.dirname, '..')
const [command, argument] = process.argv.slice(2)
const started = performance.now()

try {
	let result: unknown
	if (command === 'init') result = await initialize(root)
	else {
		if (!argument)
			throw new Error(
				'Usage: report init | checkout <new-directory> | check <directory> | apply <directory> | render <directory>',
			)
		const directory = resolve(argument)
		if (command === 'checkout') result = await checkout(root, directory)
		else if (command === 'check') {
			const candidate = await prepare(root, directory)
			result = { valid: true, changed: candidate.changed, baseRevision: candidate.revision }
		} else if (command === 'apply') result = await apply(root, directory)
		else if (command === 'render') {
			const fonts: unknown = JSON.parse(process.env.TYPST_FONT_FILES ?? '[]')
			if (
				!Array.isArray(fonts) ||
				fonts.length === 0 ||
				fonts.some((font) => typeof font !== 'string')
			)
				throw new Error(
					'Set TYPST_FONT_FILES to a JSON array of font paths, including Noto Serif CJK SC.',
				)
			result = await render(root, directory, fonts)
		} else throw new Error(`Unknown command: ${command}`)
	}
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
						message: error instanceof Error ? error.message : String(error),
						cause: error instanceof Error ? error.cause : undefined,
					},
			null,
			2,
		),
	)
	process.exitCode = 1
}

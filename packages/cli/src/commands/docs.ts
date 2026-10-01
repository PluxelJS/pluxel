import { readFileSync, realpathSync } from 'node:fs'
import { resolve, relative } from 'pathe'
import { type ArgValues, define } from 'gunshi'
import { docsCommandArgs, docsCommandDefinition } from '../command-manifest'
import { developmentSource } from '../workspace/setup'

type DocsValues = ArgValues<typeof docsCommandArgs>
export function readDocumentation(rawPath: string | undefined, source = developmentSource()) {
	const path = rawPath?.trim() || 'development/index.md'
	if (
		path.startsWith('/') ||
		path.includes('\\') ||
		path.split('/').some((part) => !part || part === '.' || part === '..')
	)
		throw new Error('Documentation path must be a relative path below docs/')
	const root = realpathSync(
		resolve(source.root, source.kind === 'git' ? 'docs' : 'dist/resources/docs'),
	)
	const file = realpathSync(resolve(root, path))
	if (relative(root, file).startsWith('../')) throw new Error('Documentation path escapes docs/')
	return { source, file, content: readFileSync(file, 'utf8') }
}
export const docsCommand = define({
	...docsCommandDefinition,
	run(ctx) {
		const document = readDocumentation((ctx.values as DocsValues).path)
		ctx.log(
			`Source: ${document.source.kind} ${document.source.root} (${document.source.version})\nFile: ${document.file}\n\n${document.content}`,
		)
	},
})

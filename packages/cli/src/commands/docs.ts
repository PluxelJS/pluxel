import { type ArgValues, define } from 'gunshi'
import { docsCommandArgs, docsCommandDefinition } from '../command-manifest'

type DocsValues = ArgValues<typeof docsCommandArgs>

const documentationRoot = 'https://github.com/PluxelJS/pluxel/blob/main/docs'

export function resolveDocumentationUrl(rawPath: string | undefined): string {
	const path = rawPath?.trim() || 'index.md'
	const segments = path.split('/')
	if (
		path.startsWith('/') ||
		path.includes('\\') ||
		segments.some((segment) => segment === '' || segment === '.' || segment === '..')
	) {
		throw new Error(
			'Documentation path must be a relative path below docs/, for example development/testing.md',
		)
	}
	return `${documentationRoot}/${segments.map(encodeURIComponent).join('/')}`
}

export const docsCommand = define({
	...docsCommandDefinition,
	run(ctx) {
		const values = ctx.values as DocsValues
		ctx.log(resolveDocumentationUrl(values.path))
	},
})

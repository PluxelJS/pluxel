import type { MDXComponents } from 'mdx/types'
import * as Twoslash from 'fumadocs-twoslash/ui'
import { TypeTable } from 'fumadocs-ui/components/type-table'
import defaultMdxComponents from 'fumadocs-ui/mdx'

export function getMDXComponents(components?: MDXComponents) {
	return {
		...defaultMdxComponents,
		...Twoslash,
		TypeTable,
		// The repository Markdown keeps an H1 for static readers. DocsTitle is the
		// only online H1, so the source heading is intentionally not rendered here.
		h1: () => null,
		...components,
	} satisfies MDXComponents
}

export const useMDXComponents = getMDXComponents

declare global {
	type MDXProvidedComponents = ReturnType<typeof getMDXComponents>
}

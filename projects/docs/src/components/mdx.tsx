import type { MDXComponents } from 'mdx/types'
import * as Twoslash from 'fumadocs-twoslash/ui'
import { TypeTable } from 'fumadocs-ui/components/type-table'
import defaultMdxComponents from 'fumadocs-ui/mdx'
import { PackageInstall } from './package-install'

export function getMDXComponents(components?: MDXComponents) {
	return {
		...defaultMdxComponents,
		...Twoslash,
		PackageInstall,
		TypeTable,
		...components,
	} satisfies MDXComponents
}

export const useMDXComponents = getMDXComponents

declare global {
	type MDXProvidedComponents = ReturnType<typeof getMDXComponents>
}

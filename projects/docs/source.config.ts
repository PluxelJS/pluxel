import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins'
import { transformerTwoslash } from 'fumadocs-twoslash'
import { createFileSystemTypesCache } from 'fumadocs-twoslash/cache-fs'
import { defineConfig } from 'fumadocs-mdx/config'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { remarkPackageInstall } from './src/remark-package-install'

const docsRoot = fileURLToPath(new URL('.', import.meta.url))
const development = process.env.DOCS_TWOSLASH_MODE === 'development'

export default defineConfig({
	mdxOptions: {
		remarkPlugins: [remarkPackageInstall],
		rehypeCodeOptions: {
			...rehypeCodeDefaultOptions,
			transformers: [
				...(rehypeCodeDefaultOptions.transformers ?? []),
				transformerTwoslash({
					explicitTrigger: true,
					typesCache: createFileSystemTypesCache({
						cwd: docsRoot,
						dir: development ? '.cache/twoslash-v4-development' : '.cache/twoslash-v3-production',
					}),
					twoslashOptions: {
						vfsRoot: docsRoot,
						handbookOptions: {
							noStaticSemanticInfo: development,
						},
						compilerOptions: {
							customConditions: ['@pluxel/source'],
							jsx: ts.JsxEmit.ReactJSX,
							module: ts.ModuleKind.ESNext,
							moduleResolution: ts.ModuleResolutionKind.Bundler,
							target: ts.ScriptTarget.ESNext,
						},
					},
				}),
			],
			langs: ['js', 'jsx', 'ts', 'tsx'],
		},
	},
})

import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins'
import { transformerTwoslash } from 'fumadocs-twoslash'
import { createFileSystemTypesCache } from 'fumadocs-twoslash/cache-fs'
import { defineConfig } from 'fumadocs-mdx/config'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript-legacy'
import { remarkPackageInstall } from './src/remark-package-install'

const docsRoot = fileURLToPath(new URL('.', import.meta.url))
const tsLibDirectory = dirname(
	fileURLToPath(import.meta.resolve('typescript-legacy/lib/typescript.js')),
)
// Twoslash types its compiler hook against the workspace TypeScript package. The isolated
// legacy compiler implements that API surface at runtime, but its module declaration is distinct.
const twoslashTypeScript = ts as unknown as typeof import('typescript') & {
	default: typeof import('typescript')
}
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
						tsModule: twoslashTypeScript,
						tsLibDirectory,
						vfsRoot: docsRoot,
						handbookOptions: {
							noStaticSemanticInfo: development,
						},
						compilerOptions: {
							allowImportingTsExtensions: true,
							noEmit: true,
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

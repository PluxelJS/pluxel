import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins'
import { transformerTwoslash } from 'fumadocs-twoslash'
import { createFileSystemTypesCache } from 'fumadocs-twoslash/cache-fs'
import { defineConfig } from 'fumadocs-mdx/config'
import { fileURLToPath } from 'node:url'
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
						dir: development ? '.cache/twoslash-ts7-development' : '.cache/twoslash-ts7-production',
					}),
					twoslashOptions: {
						cwd: docsRoot,
						handbookOptions: {
							noStaticSemanticInfo: development,
						},
						compilerOptions: {
							allowImportingTsExtensions: true,
							noEmit: true,
							customConditions: ['@pluxel/source'],
							jsx: 'react-jsx',
							module: 'esnext',
							moduleResolution: 'bundler',
							target: 'esnext',
						},
					},
				}),
			],
			langs: ['js', 'jsx', 'ts', 'tsx'],
		},
	},
})

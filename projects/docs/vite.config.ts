import { repositoryTasks } from '../../scripts/vite-tasks'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig, lazyPlugins, type Plugin } from 'vite-plus'
import { exampleThemeVariants } from './scripts/example-theme-variants'

const require = createRequire(import.meta.url)

function examplePlugins(): Plugin[] {
	// Task discovery precedes compiler artifacts. Fumapress invokes this factory after
	// closing its config module runner, so use Node's ESM-capable loader here.
	const { configSourcePlugin, createPluginSemanticsPlugin } =
		require('@pluxel/rolldown/plugins') as typeof import('@pluxel/rolldown/plugins')
	return [
		exampleThemeVariants(),
		createPluginSemanticsPlugin({
			root: fileURLToPath(new URL('.', import.meta.url)),
			include: [
				'**/*.ts',
				'**/*.tsx',
				'**/*.mts',
				'**/*.cts',
				'**/*.js',
				'**/*.jsx',
				'**/*.mjs',
				'**/*.cjs',
				// Query versions still need lowering before Vite erases their TypeScript.
				'**/src/examples/typst/theme-plugin.ts?example-theme=*',
			],
		}).plugin,
		configSourcePlugin(),
	] as Plugin[]
}

function bundleModernMonacoTypeScriptWorker(): Plugin {
	return {
		name: 'bundle-modern-monaco-typescript-worker',
		enforce: 'pre',
		resolveId(source, importer) {
			// Modern Monaco needs the classic JS Compiler API, which TS 7 does not expose.
			if (source === 'typescript' && importer?.includes('/modern-monaco/dist/lsp/typescript/')) {
				return this.resolve('typescript-legacy', fileURLToPath(import.meta.url))
			}
			return undefined
		},
		transform(code, id) {
			if (!id.includes('/modern-monaco/dist/lsp/typescript/setup.mjs')) return undefined

			const workerFactory = /function createWebWorker\(\) \{[\s\S]*?\n\}\nfunction getWorker/
			if (!workerFactory.test(code)) {
				throw new Error('Modern Monaco TypeScript worker factory was not found')
			}

			return code.replace(
				workerFactory,
				`function createWebWorker() {
  return new Worker(new URL("./worker.mjs", import.meta.url), {
    type: "module",
    name: "typescript-worker"
  });
}
function getWorker`,
			)
		},
	}
}

export default defineConfig({
	run: {
		tasks: {
			...repositoryTasks({
				compile: {
					command: 'cross-env DEBUG= DOCS_TWOSLASH_MODE=production fumapress build',
					dependsOn: ['prepare:docs'],
					cache: {
						input: [
							{ pattern: 'docs/**', base: 'workspace' },
							'!dist/**',
							'!.source/**',
							'!.vercel/output/**',
						],
						output: ['dist/**', '.source/**', '.vercel/output/**'],
						env: ['VERCEL*'],
					},
				},
				'check-types': {
					command: 'tsc --noEmit',
					dependsOn: ['prepare:docs', '@pluxel/rolldown#compile'],
				},
			}),
			'generate:playground-types': {
				command: 'node scripts/generate-playground-types.mjs',
				cache: false,
			},
			'prepare:docs': {
				command: [],
				dependsOn: [
					'generate:playground-types',
					'@pluxel/core#compile',
					'@pluxel/host#compile',
					'@pluxel/services#compile',
					'@pluxel/plugin-takumi-markdown#compile',
					// Browser examples consume the source/parser WASM exports, without the native addon.
					'@pluxel/plugin-typst#compile-lib',
					'valibot-form#compile',
				],
				cache: false,
			},
			serve: {
				command: 'cross-env DEBUG= DOCS_TWOSLASH_MODE=development fumapress dev',
				dependsOn: ['prepare:docs'],
				cache: false,
			},
		},
	},
	worker: {
		format: 'es',
		plugins: () => [bundleModernMonacoTypeScriptWorker(), ...examplePlugins()],
	},
	optimizeDeps: {
		exclude: ['lucide-react', 'modern-monaco/lsp/typescript/setup', '@pluxel/plugin-typst/wasm'],
		include: ['typescript-legacy'],
	},
	// Workspace editor peers must share the SSR renderer's React instance.
	ssr: { noExternal: [/^@tiptap\//] },
	plugins: lazyPlugins(async () => {
		const [{ default: press }, { fumadocsMdx }, { default: tailwindcss }] = await Promise.all([
			import('fumapress/vite'),
			import('fumadocs-mdx/vite'),
			import('@tailwindcss/vite'),
		])
		return [
			bundleModernMonacoTypeScriptWorker(),
			...examplePlugins(),
			press(),
			fumadocsMdx(),
			tailwindcss(),
		]
	}),
	// The canonical docs source lives outside this Vite root, so Rolldown needs
	// explicit framework resolution for virtual MDX modules from ../../docs.
	resolve: {
		dedupe: ['react', 'react-dom'],
		conditions: ['@pluxel/hmr', 'module', 'browser', 'development|production'],
	},
})

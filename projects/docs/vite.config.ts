import { repositoryTasks } from '../../scripts/vite-tasks'
import { fileURLToPath } from 'node:url'
import { defineConfig, lazyPlugins, type Plugin } from 'vite-plus'

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
			...repositoryTasks('pluxel-docs', {
				build: 'cross-env DEBUG= DOCS_TWOSLASH_MODE=production fumapress build',
				typecheck: 'tsc --noEmit',
			}),
			'generate:playground-types': {
				command: 'node scripts/generate-playground-types.mjs',
				cache: false,
			},
		},
	},
	worker: {
		plugins: () => [bundleModernMonacoTypeScriptWorker()],
	},
	optimizeDeps: {
		exclude: ['lucide-react', 'modern-monaco/lsp/typescript/setup'],
		include: ['typescript-legacy'],
	},
	plugins: lazyPlugins(async () => {
		const [{ default: press }, { fumadocsMdx }, { default: tailwindcss }] = await Promise.all([
			import('fumapress/vite'),
			import('fumadocs-mdx/vite'),
			import('@tailwindcss/vite'),
		])
		return [bundleModernMonacoTypeScriptWorker(), press(), fumadocsMdx(), tailwindcss()]
	}),
	// The canonical docs source lives outside this Vite root, so Rolldown needs
	// explicit framework resolution for virtual MDX modules from ../../docs.
	resolve: {
		dedupe: ['react', 'react-dom'],
	},
})

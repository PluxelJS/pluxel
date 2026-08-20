import tailwindcss from '@tailwindcss/vite'
import { fumadocsMdx } from 'fumadocs-mdx/vite'
import press from 'fumapress/vite'
import { defineConfig, type Plugin } from 'vite'

function bundleModernMonacoTypeScriptWorker(): Plugin {
	return {
		name: 'bundle-modern-monaco-typescript-worker',
		enforce: 'pre',
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
	optimizeDeps: {
		exclude: ['modern-monaco/lsp/typescript/setup'],
		include: ['typescript'],
	},
	plugins: [bundleModernMonacoTypeScriptWorker(), press(), fumadocsMdx(), tailwindcss()],
	// The canonical docs source lives outside this Vite root, so Rolldown needs
	// explicit framework resolution for virtual MDX modules from ../../docs.
	resolve: {
		dedupe: ['react', 'react-dom'],
	},
})

import tailwindcss from '@tailwindcss/vite'
import { fumadocsMdx } from 'fumadocs-mdx/vite'
import press from 'fumapress/vite'
import type { Plugin } from 'vite'
import { defineConfig } from 'waku/config'

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
	vite: {
		optimizeDeps: {
			exclude: ['modern-monaco/lsp/typescript/setup'],
			include: ['typescript'],
		},
		plugins: [bundleModernMonacoTypeScriptWorker(), press(), fumadocsMdx(), tailwindcss()],
		resolve: {
			dedupe: ['react', 'react-dom'],
		},
	},
})

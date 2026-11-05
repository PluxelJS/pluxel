import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'

export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	base: './',
	publicDir: false,
	resolve: { conditions: ['@pluxel/hmr', 'module', 'browser', 'development|production'] },
	build: {
		outDir: '../dist/web',
		emptyOutDir: true,
		target: 'es2023',
	},
})

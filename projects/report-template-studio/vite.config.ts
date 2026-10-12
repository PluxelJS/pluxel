import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { offlineMonaco } from './scripts/monaco-vite.ts'
import { generateEditorTypes } from './scripts/generate-editor-types.mjs'

export default defineConfig({
	base: './',
	// Declaration files must reach the language worker unchanged, without Vite's TS transform.
	publicDir: '.editor-generated/public',
	cacheDir: '.studio-dev/vite-renderer',
	plugins: [
		react(),
		offlineMonaco(),
		{ name: 'studio-editor-types', buildStart: generateEditorTypes },
	],
	worker: { format: 'es', plugins: () => [offlineMonaco()] },
	optimizeDeps: { exclude: ['modern-monaco', 'modern-monaco/lsp/typescript/setup'] },
	build: {
		outDir: 'dist/renderer',
		emptyOutDir: true,
		target: 'es2023',
		rolldownOptions: {
			output: { assetFileNames: 'assets/[hash]/[name][extname]' },
			onLog(level, log, handler) {
				// This Electron renderer is entirely client-side; React Server Component
				// boundary directives in dependencies have no semantics here.
				if (log.code === 'MODULE_LEVEL_DIRECTIVE' && log.message.includes('use client')) return
				handler(level, log)
			},
		},
	},
})

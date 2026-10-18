import { repositoryTasks } from '../../scripts/vite-tasks'
import { defineConfig, lazyPlugins } from 'vite-plus'
import react from '@vitejs/plugin-react'
import { offlineMonaco } from './scripts/monaco-vite.ts'
import { generateEditorTypes } from './scripts/generate-editor-types.mjs'

const tasks = repositoryTasks('@report-template-studio/app', {
	build: 'node ../../scripts/pack.mjs',
	test: 'vp test run',
	typecheck: 'tsc --noEmit',
})
const compile = tasks.compile!
const compileCache = typeof compile.cache === 'object' ? compile.cache : {}

export default defineConfig({
	run: {
		tasks: {
			...tasks,
			'compile-code': {
				...compile,
				cache: {
					...compileCache,
					input: [...(compileCache.input ?? [{ auto: true }]), '!dist/**'],
					output: [
						'dist/*.mjs',
						'dist/*.mjs.map',
						'dist/*.d.mts',
						'dist/electron/**',
						'dist/artifacts/**',
					],
				},
			},
			compile: {
				command: 'vp build',
				dependsOn: ['compile-code'],
				cache: { ...compileCache, output: ['dist/renderer/**'] },
			},
		},
	},
	base: './',
	// Declaration files must reach the language worker unchanged, without Vite's TS transform.
	publicDir: '.editor-generated/public',
	cacheDir: '.studio-dev/vite-renderer',
	plugins: lazyPlugins(() => [
		react(),
		offlineMonaco(),
		{ name: 'studio-editor-types', buildStart: generateEditorTypes },
	]),
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

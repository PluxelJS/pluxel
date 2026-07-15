import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const runtimeDevEntry = fileURLToPath(new URL('../runtime-dev/src/index.ts', import.meta.url))
const runtimeDevHmrLog = fileURLToPath(new URL('../runtime-dev/src/hmr-log.ts', import.meta.url))
const runtimeDevViteEntry = fileURLToPath(new URL('../runtime-dev/src/vite.ts', import.meta.url))

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		neverBundle: [
			'@pluxel/core',
			'@pluxel/rolldown',
			'@pluxel/rolldown/*',
			'@pluxel/runtime',
			'@pluxel/runtime/*',
			'@pluxel/runtime/internal',
			'@pluxel/runtime/shared',
			'@pluxel/runtime/web/paths',
			'vite',
			'vite/*',
		],
		alwaysBundle: ['@pluxel/runtime-dev', '@pluxel/runtime-dev/*'],
	},
	alias: {
		'@pluxel/runtime-dev': runtimeDevEntry,
		'@pluxel/runtime-dev/hmr-log': runtimeDevHmrLog,
		'@pluxel/runtime-dev/vite': runtimeDevViteEntry,
	},
	entry: {
		index: 'src/index.ts',
		'internal/node-application': 'src/internal/node-application.ts',
		'internal/node-workbench-application': 'src/internal/node-workbench-application.ts',
		test: 'src/test.ts',
		vite: 'src/vite.ts',
	},
	dts: {
		sourcemap: true,
		eager: true,
	},
	format: ['esm'],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
})

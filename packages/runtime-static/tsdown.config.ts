import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import { pluxelViteSourceBridgeExternal } from '../runtime-dev/tsdown-source-bridge.ts'

const runtimeDevEntry = fileURLToPath(new URL('../runtime-dev/src/index.ts', import.meta.url))
const runtimeDevHmrLog = fileURLToPath(new URL('../runtime-dev/src/hmr-log.ts', import.meta.url))
const runtimeDevViteEntry = fileURLToPath(new URL('../runtime-dev/src/vite.ts', import.meta.url))
const runtimeNodeEntry = fileURLToPath(new URL('../runtime-node/src/index.ts', import.meta.url))

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		alwaysBundle: [
			'@pluxel/runtime-dev',
			'@pluxel/runtime-dev/*',
			'@pluxel/runtime-node',
			'valibot-form',
			'valibot-form/*',
		],
		neverBundle: [
			'@pluxel/core',
			'@pluxel/rolldown',
			'@pluxel/rolldown/*',
			'@pluxel/runtime',
			'@pluxel/runtime/*',
			'@pluxel/runtime/internal',
			'vite',
			'vite/*',
		],
	},
	alias: {
		'@pluxel/runtime-dev': runtimeDevEntry,
		'@pluxel/runtime-dev/hmr-log': runtimeDevHmrLog,
		'@pluxel/runtime-dev/vite': runtimeDevViteEntry,
		'@pluxel/runtime-node': runtimeNodeEntry,
	},
	plugins: [pluxelViteSourceBridgeExternal()],
	entry: {
		index: 'src/index.ts',
		'internal/fetch-application': 'src/internal/fetch-application.ts',
		'internal/fetch-workbench-application': 'src/internal/fetch-workbench-application.ts',
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

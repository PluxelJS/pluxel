import { defineConfig } from 'tsdown'
import { pluxelRuntimeNodeSourceBridgeExternal } from './tsdown-source-bridge.ts'

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
			'@pluxel/runtime/internal',
			'@pluxel/runtime-node',
			'vite',
			'vite/*',
		],
	},
	plugins: [pluxelRuntimeNodeSourceBridgeExternal()],
	entry: {
		index: 'src/index.ts',
		workbench: 'src/workbench.ts',
		'hmr-log': 'src/hmr-log.ts',
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

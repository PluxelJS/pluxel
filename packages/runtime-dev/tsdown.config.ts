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
		// TS7's native declaration generator uses the config directory as rootDir. This root-level,
		// package-scoped config keeps intentional sibling source bridges inside that root so their
		// intermediate declarations stay in rolldown-plugin-dts's disposable output directory.
		tsconfig: '../../tsconfig.runtime-dev-dts.json',
		sourcemap: true,
		eager: true,
	},
	format: ['esm'],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
})

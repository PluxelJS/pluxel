import { defineConfig } from 'tsdown'

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
			'@pluxel/runtime/shared',
			'@pluxel/runtime/web/federation',
			'@pluxel/runtime/web/paths',
			'vite',
			'vite/*',
		],
	},
	entry: {
		index: 'src/index.ts',
		extensions: 'src/extensions.ts',
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

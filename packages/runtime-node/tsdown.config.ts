import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		neverBundle: [
			'@pluxel/runtime',
			'@pluxel/runtime/internal',
			'crossws',
			'crossws/*',
			'elysia',
			'elysia/*',
			'srvx',
			'srvx/*',
		],
	},
	entry: {
		index: 'src/index.ts',
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

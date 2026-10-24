import { defineConfig } from 'vite-plus/pack'

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		neverBundle: ['@pluxel/core', '@pluxel/rolldown', '@pluxel/rolldown/*', 'vite', 'vite/*'],
	},
	entry: {
		console: 'src/console.ts',
		internal: 'src/internal.ts',

		index: 'src/index.ts',
		run: 'src/run.ts',
	},
	dts: {
		// Generate declarations from production source only.
		tsconfig: './tsconfig.build.json',
		sourcemap: true,
		eager: true,
	},
	format: ['esm'],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
})

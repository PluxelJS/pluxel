import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: { devExports: '@pluxel/source' },
	entry: {
		index: './src/index.ts',
		vite: './src/vite.ts',
		build: './src/build.ts',
		test: './src/test.ts',
		'internal/test': './src/internal-test.ts',
	},
	format: ['esm'],
	dts: { eager: true },
	clean: true,
	treeshake: true,
})

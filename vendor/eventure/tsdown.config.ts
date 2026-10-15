import { defineConfig } from 'vite-plus/pack'

export default defineConfig({
	exports: {
		devExports: 'source',
	},
	entry: {
		index: 'src/index.ts',
	},
	dts: {
		sourcemap: true,
	},
	format: ['esm', 'cjs'],
	clean: true,
	minify: true,
	treeshake: true,
})

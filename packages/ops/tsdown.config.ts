import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	entry: {
		index: './src/index.ts',
		typebox: './src/typebox.ts',
	},
	dts: {
		sourcemap: true,
		eager: true,
	},
	format: ['esm', 'cjs'],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
	inputOptions: {
		transform: {
			assumptions: {
				setPublicClassFields: true,
			},
			typescript: {
				removeClassFieldsWithoutInitializer: true,
			},
		},
	},
})

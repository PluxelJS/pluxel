import { defineConfig } from 'tsdown'

// biome-ignore lint/style/noDefaultExport: tsdown config expects a default export.
export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
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

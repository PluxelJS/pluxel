import { defineConfig } from 'tsdown'

export default defineConfig({
	inlineOnly: [/^option-t(\/.*)?$/],
	exports: {
		devExports: '@pluxel/source',
	},
	entry: './src/index.ts',
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

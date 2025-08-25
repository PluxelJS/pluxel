import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: false,
	entry: {
		index: 'src/index.ts',
		service: 'src/service/index.ts',
	},
	dts: {
		sourcemap: true,
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
			decorator: {
				legacy: true,
				emitDecoratorMetadata: true,
			},
		},
	},
})

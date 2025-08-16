import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	entry: {
		index: 'src/context.ts',
		services: 'src/services/index.ts',
	},
	env: {
		NODE_ENV: 'production',
	},
	define: {
		'import.meta.env.PROD': 'true',
	},
	dts: {
		sourcemap: true,
	},
	format: ['esm'],
	sourcemap: true,
	clean: true,
	minify: false,
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

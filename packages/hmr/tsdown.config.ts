import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	entry: {
		index: 'src/index.ts',
		services: 'src/services/index.ts',
	},
	env: {
		NODE_ENV: 'production',
		PROD: true,
	},
	dts: {
		build: true,
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

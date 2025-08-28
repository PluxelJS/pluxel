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
		PROD: true,
	},
	dts: {
		build: true,
	},
	// 不要内联 core，未来可能要用来 build。
	external: ['@pluxel/core'],
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

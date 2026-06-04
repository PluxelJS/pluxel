import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		neverBundle: [
			'@pluxel/core',
			'@pluxel/core/services',
			'@pluxel/runtime',
			'@pluxel/runtime/internal',
			'@pluxel/runtime/plugin-catalog',
			'@pluxel/runtime/shared',
		],
	},
	entry: {
		index: 'src/index.ts',
		register: 'src/register.ts',
		services: 'src/services.ts',
	},
	dts: {
		sourcemap: true,
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

import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: {
		create: './src/create.ts',
	},
	copy: ['template', '../../docs'],
	dts: false,
	exports: {
		bin: {
			'create-pluxel': './src/create.ts',
		},
		exclude: ['create'],
		inlinedDependencies: false,
		legacy: false,
	},
	format: ['esm'],
	platform: 'node',
	target: 'node24',
	clean: true,
	sourcemap: false,
	treeshake: true,
	outputOptions: {
		codeSplitting: false,
	},
})

import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: { devExports: '@pluxel/source' },
	entry: {
		application: './src/application.ts',
		'config-environment': './src/config-environment.ts',
		environment: './src/environment.ts',
		index: './src/index.ts',
		internal: './src/internal.ts',
	},
	format: ['esm'],
	dts: { eager: true },
	clean: true,
	treeshake: true,
})

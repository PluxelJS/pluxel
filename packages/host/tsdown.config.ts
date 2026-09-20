import { defineConfig } from 'tsdown'

export default defineConfig({
	exports: { devExports: '@pluxel/source' },
	entry: {
		'config-environment': './src/config-environment.ts',
		environment: './src/environment.ts',
		dynamic: './src/dynamic/index.ts',
		'dynamic/source-producer': './src/dynamic/source-producer.ts',
		index: './src/index.ts',
		internal: './src/internal.ts',
		'internal/protocol': './src/execution.ts',
	},
	format: ['esm'],
	dts: { eager: true },
	clean: true,
	treeshake: true,
})

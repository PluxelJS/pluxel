import { defineConfig } from 'vite-plus/pack'
export default defineConfig({
	entry: {
		host: './src/host.ts',
		source: './src/source.ts',
		client: './src/client.ts',
		'internal/client': './src/internal-client.ts',
	},
	exports: { devExports: '@pluxel/source' },
	deps: { neverBundle: [/^@pluxel\//] },
	format: ['esm'],
	dts: { eager: true, sourcemap: true },
	clean: true,
	sourcemap: true,
})

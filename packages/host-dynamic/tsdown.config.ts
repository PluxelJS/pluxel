import { defineConfig } from 'tsdown'
export default defineConfig({
	entry: { index: 'src/index.ts', 'source-producer': 'src/source-producer.ts' },
	exports: { devExports: '@pluxel/source' },
	dts: true,
	format: ['esm'],
	clean: true,
})

import { defineConfig } from 'vite-plus/pack'

export default defineConfig({
	entry: { index: 'src/index.ts' },
	dts: true,
	format: ['esm'],
	sourcemap: true,
	clean: true,
})

import { defineConfig } from 'vite-plus/pack'

export default defineConfig({
	entry: { index: 'src/index.ts' },
	platform: 'neutral',
	target: 'es2024',
	format: ['esm'],
	dts: { eager: true },
})

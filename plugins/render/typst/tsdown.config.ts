import { defineConfig } from 'vite-plus/pack'

export default defineConfig({
	tsconfig: './tsconfig.json',
	entry: { index: 'src/index.ts', browser: 'src/browser/preview.ts', template: 'src/template.ts' },
	dts: { eager: true },
	format: ['esm'],
	sourcemap: true,
	clean: true,
})

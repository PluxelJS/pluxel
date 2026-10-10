import { defineConfig } from 'tsdown'

export default defineConfig({
	tsconfig: './tsconfig.json',
	entry: { index: 'src/index.ts', browser: 'src/browser/preview.ts' },
	dts: { eager: true },
	format: ['esm'],
	sourcemap: true,
	clean: true,
})

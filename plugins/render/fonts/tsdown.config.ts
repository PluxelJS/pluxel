import { defineConfig } from 'tsdown'

export default defineConfig({
	tsconfig: './tsconfig.json',
	entry: {
		index: 'src/index.ts',
		workbench: 'src/workbench-contract.ts',
	},
	dts: { eager: true, sourcemap: true },
	format: ['esm'],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
})

import { defineConfig } from 'vite-plus/pack'

export default defineConfig({
	tsconfig: './tsconfig.build.json',
	entry: {
		index: 'src/index.ts',
		workbench: 'src/workbench.ts',
	},
	dts: { eager: true, sourcemap: true },
	format: ['esm'],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
})

import { defineConfig } from 'tsdown'

export default defineConfig({
	tsconfig: './tsconfig.json',
	entry: {
		index: 'src/index.ts',
		pretext: 'src/pretext.ts',
		table: 'src/table.ts',
		worker: 'src/worker.ts',
		'worker/pretext': 'src/worker-pretext.ts',
	},
	dts: { eager: true, sourcemap: true },
	format: ['esm'],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
})

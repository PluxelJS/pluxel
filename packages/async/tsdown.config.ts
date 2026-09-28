import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: {
		grfn: 'src/grfn/index.ts',
		iter: 'src/iter/index.ts',
		limit: 'src/limit/index.ts',
		retry: 'src/retry/index.ts',
		singleflight: 'src/singleflight/index.ts',
		wait: 'src/wait/index.ts',
	},
	platform: 'neutral',
	target: 'es2022',
	tsconfig: 'tsconfig.build.json',
	dts: { eager: true },
	format: ['esm'],
	clean: true,
	treeshake: true,
	exports: { devExports: '@pluxel/source' },
})

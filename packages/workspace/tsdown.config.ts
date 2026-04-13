import { defineConfig } from 'tsdown'

const fastBuild = process.env.PLUXEL_FAST_BUILD === 'true'

export default defineConfig({
	entry: {
		index: './src/index.ts',
		oxlint: './src/oxlint/index.ts',
	},
	dts: {
		sourcemap: !fastBuild,
		eager: true,
	},
	env: {
		BUILD: 'true',
		DEV: 'false',
		NODE_ENV: 'production',
	},
	format: ['esm'],
	clean: true,
	sourcemap: !fastBuild,
	minify: true,
	treeshake: true,
})

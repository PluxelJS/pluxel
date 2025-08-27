import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: './src/cli.ts',
	dts: {
		build: true,
		sourcemap: true,
	},
	copy: ['plop-templates'],
	env: {
		PROD: true,
	},
	format: ['esm'],
	clean: true,
	minify: true,
	treeshake: true,
})

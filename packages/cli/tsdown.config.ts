import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: './src/cli.ts',
	dts: {
		sourcemap: true,
	},
	env: {
		BUILD: 'true',
	},
	copy: ['plop-templates'],
	plugins: [],
	format: ['esm'],
	clean: true,
	minify: true,
	treeshake: true,
})

import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: {
		cli: './src/cli.ts',
		build: './src/build.ts',
		'build/cli': './src/build/cli.ts',
		rolldown: './src/rolldown.ts',
	},
	// Inline internal build helpers so published CLI doesn't depend on @pluxel/build at runtime.
	noExternal: ['@pluxel/build', '@pluxel/build/*'],
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

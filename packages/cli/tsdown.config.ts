import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const buildRoot = fileURLToPath(new URL('../build/src', import.meta.url))
const buildCli = fileURLToPath(new URL('../build/src/cli/index.ts', import.meta.url))
const buildRolldown = fileURLToPath(new URL('../build/src/rolldown/index.ts', import.meta.url))

export default defineConfig({
	entry: {
		cli: './src/cli.ts',
		build: './src/build.ts',
		'build/cli': './src/build/cli.ts',
		rolldown: './src/rolldown.ts',
	},
	// Inline internal build helpers so published CLI doesn't depend on @pluxel/build at runtime.
	noExternal: ['@pluxel/build', '@pluxel/build/*'],
	alias: {
		'@pluxel/build': buildRoot,
		'@pluxel/build/cli': buildCli,
		'@pluxel/build/rolldown': buildRolldown,
	},
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

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const buildRoot = fileURLToPath(new URL('../build/src', import.meta.url))
const buildCli = fileURLToPath(new URL('../build/src/cli/index.ts', import.meta.url))
const buildRolldown = fileURLToPath(new URL('../build/src/rolldown/index.ts', import.meta.url))

const fastBuild = process.env.PLUXEL_FAST_BUILD === 'true'

export default defineConfig({
	entry: {
		cli: './src/cli.ts',
		build: './src/build.ts',
		rolldown: './src/rolldown.ts',
		hmr: './src/hmr/index.ts',
		workspace: './src/workspace/index.ts',
	},
	// Inline internal build helpers so published CLI doesn't depend on @pluxel/build at runtime.
	noExternal: ['@pluxel/build', '@pluxel/build/*'],
	alias: {
		'@pluxel/build': buildRoot,
		'@pluxel/build/cli': buildCli,
		'@pluxel/build/rolldown': buildRolldown,
	},
	dts: {
		sourcemap: !fastBuild,
		eager: true,
	},
	env: {
		BUILD: 'true',
	},
	copy: ['plop-templates'],
	plugins: [],
	format: ['esm'],
	clean: true,
	sourcemap: !fastBuild,
	minify: true,
	treeshake: true,
})

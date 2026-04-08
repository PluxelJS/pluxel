import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const buildRoot = fileURLToPath(new URL('../build/src', import.meta.url))
const buildRolldown = fileURLToPath(new URL('../build/src/rolldown/index.ts', import.meta.url))

export default defineConfig({
	// This package ships as a bundled dev tool (Vitest preset + transforms).
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		// Bundle internal build helpers so consumers don't need @pluxel/build at runtime.
		alwaysBundle: ['@pluxel/build', '@pluxel/build/*'],
	},
	entry: {
		fixtures: './src/fixtures.ts',
		index: './src/index.ts',
		oxlint: './src/oxlint.ts',
		setup: './src/setup.ts',
		vitest: './src/vitest.ts',
		unsafe: './src/unsafe.ts',
	},
	dts: {
		sourcemap: true,
		eager: true,
	},
	format: ['esm', 'cjs'],
	sourcemap: true,
	clean: true,
	minify: true,
	treeshake: true,
	alias: {
		'@pluxel/build': buildRoot,
		'@pluxel/build/rolldown': buildRolldown,
	},
	inputOptions: {
		transform: {
			assumptions: {
				setPublicClassFields: true,
			},
			typescript: {
				removeClassFieldsWithoutInitializer: true,
			},
		},
	},
	outputOptions: (options, format) => {
		if (format !== 'cjs') return
		return {
			...options,
			exports: 'named',
		}
	},
})

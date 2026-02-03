import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const buildRoot = fileURLToPath(new URL('../build/src', import.meta.url))
const buildRolldown = fileURLToPath(new URL('../build/src/rolldown/index.ts', import.meta.url))

export default defineConfig({
	inlineOnly: [/^pathe(\/.*)?$/],
	exports: {
		devExports: '@pluxel/source',
	},
	entry: {
		index: './src/index.ts',
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
	// Bundle internal build helpers so consumers don't need @pluxel/build at runtime.
	noExternal: ['@pluxel/build', '@pluxel/build/*'],
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

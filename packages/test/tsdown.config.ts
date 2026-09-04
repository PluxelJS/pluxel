import { defineConfig } from 'tsdown'

const inlineRuntimeDeps = ['@platformatic/vfs', 'fs-fixture']

export default defineConfig({
	// This package ships as a bundled dev tool (Vitest preset + transforms).
	exports: {
		devExports: '@pluxel/source',
		legacy: false,
	},
	deps: {
		neverBundle: ['@pluxel/rolldown', '@pluxel/rolldown/*'],
		onlyBundle: inlineRuntimeDeps,
	},
	entry: {
		fixtures: './src/fixtures.ts',
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

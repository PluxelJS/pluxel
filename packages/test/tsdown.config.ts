import { defineConfig } from 'tsdown'

export default defineConfig({
	// This package ships as a bundled dev tool (Vitest preset + transforms).
	exports: {
		devExports: '@pluxel/source',
	},
	deps: {
		// The Vitest preset and oxlint bridge use private workspace build tooling; published
		// artifacts must contain that code instead of externalizing private packages.
		alwaysBundle: ['@pluxel/rolldown', '@pluxel/rolldown/*', '@pluxel/rolldown/oxlint'],
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

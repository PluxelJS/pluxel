import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: {
		cli: './src/cli.ts',
	},
	// This CLI intentionally ships as a mostly bundled artifact, but consumes
	// @pluxel/rolldown as a published toolchain package instead of vendoring it.
	deps: {
		neverBundle: [
			'@pluxel/core',
			'@pluxel/core/*',
			'@pluxel/market',
			'@pluxel/market/*',
			'@pluxel/rolldown',
			'@pluxel/rolldown/*',
			'@pluxel/runtime',
			'@pluxel/runtime/*',
			'rolldown',
			'rolldown/*',
		],
		// Bundle the small version comparator while optional toolchain owners stay external.
		alwaysBundle: ['semver'],
		onlyBundle: ['semver'],
	},
	dts: {
		sourcemap: true,
		eager: true,
	},
	env: {
		BUILD: 'true',
		DEV: 'false',
		NODE_ENV: 'production',
	},
	copy: ['templates'],
	plugins: [],
	format: ['esm'],
	clean: true,
	sourcemap: true,
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
})

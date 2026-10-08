import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: {
		cli: './src/cli.ts',
		'pncat-config': './src/workspace/pncat-config.ts',
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
			'rolldown',
			'rolldown/*',
		],
		// pncat owns catalog mutation and ships inside both Git and npm CLIs.
		// Its transitive implementation is bundled; optional Pluxel owners stay external.
		alwaysBundle: ['semver', /^@pluxel-internal\/pncat(?:\/|$)/],
		onlyBundle: false,
	},
	dts: {
		entry: ['src/cli.ts', 'src/workspace/pncat-config.ts'],
		// The bundled source belongs to both directories; tsgo roots emit at the config directory.
		tsconfig: '../../tsconfig.cli-build.json',
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
		// jiti supplies a static Babel entry specifically for bundled config loaders.
		resolve: { alias: { jiti$: 'jiti/static' } },
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

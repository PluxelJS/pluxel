import { defineConfig } from 'vite-plus/pack'
import { resolve } from 'node:path'
import { syncTemplateCatalog } from './scripts/sync-template-catalog.mjs'

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
		// The native generator overrides rootDir with the config directory; bundled pncat is a sibling.
		tsconfig: '../../tsconfig.cli-build.json',
		sourcemap: true,
		eager: true,
	},
	env: {
		BUILD: 'true',
		DEV: 'false',
		NODE_ENV: 'production',
	},
	copy: [
		{
			from: ['templates/**/*', 'templates/**/.gitignore.tpl', '!templates/**/node_modules/**'],
			to: 'dist/templates',
			flatten: false,
		},
	],
	hooks: {
		async 'build:done'() {
			await syncTemplateCatalog(resolve(import.meta.dirname, 'dist/templates/plugin'))
		},
	},
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

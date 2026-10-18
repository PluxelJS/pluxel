import { resolve } from 'node:path'
import { defineConfig } from 'vite-plus/pack'
import { syncTemplateCatalog } from '../cli/scripts/sync-template-catalog.mjs'

export default defineConfig({
	entry: {
		create: './src/create.ts',
	},
	copy: [
		{
			// The fixed starter is a product asset. Local package installs are not: Vitest can
			// create node_modules/.vite-temp while template tests run, so copying the directory
			// would race those ephemeral files and accidentally publish local dependencies.
			from: ['template/**/*', 'template/.github/**/*', '!template/**/node_modules/**'],
			to: 'dist/template',
			flatten: false,
		},
	],
	hooks: {
		// build:done is awaited after copy; the published template follows Tegami's versions.
		async 'build:done'() {
			await syncTemplateCatalog(resolve(import.meta.dirname, 'dist/template'))
		},
	},
	dts: false,
	exports: {
		bin: {
			'create-pluxel': './src/create.ts',
		},
		exclude: ['create'],
		inlinedDependencies: false,
		legacy: false,
	},
	format: ['esm'],
	platform: 'node',
	target: 'node24',
	clean: true,
	sourcemap: false,
	treeshake: true,
	outputOptions: {
		codeSplitting: false,
	},
})

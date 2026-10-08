import { glob, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import { applyCatalogSync, planCatalogSync } from '@pluxel-internal/pncat/sync'
import { dependencyPolicy } from '../cli/scripts/dependency-policy.mjs'

export default defineConfig({
	entry: {
		create: './src/create.ts',
	},
	copy: [
		{
			// The fixed starter is a product asset. Local package installs are not: Vitest can
			// create node_modules/.vite-temp while template tests run, so copying the directory
			// would race those ephemeral files and accidentally publish local dependencies.
			from: [
				'template/**/*',
				'template/.github/**/*',
				'template/.oxfmtrc.json',
				'!template/**/node_modules/**',
			],
			to: 'dist/template',
			flatten: false,
		},
	],
	hooks: {
		// build:done is awaited after copy; the published template follows Tegami's versions.
		async 'build:done'() {
			const repositoryRoot = resolve(import.meta.dirname, '../..')
			const versions = dependencyPolicy(
				await readFile(resolve(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8'),
			)
			for await (const file of glob(
				['packages/*/package.json', 'plugins/*/package.json', 'plugins/*/*/package.json'],
				{
					cwd: repositoryRoot,
					exclude: ['**/node_modules/**', '**/dist/**'],
				},
			)) {
				const manifest = JSON.parse(await readFile(resolve(repositoryRoot, file), 'utf8'))
				if (!manifest.private && typeof manifest.version === 'string')
					versions[manifest.name] = `^${manifest.version}`
			}
			const plan = await planCatalogSync({
				root: resolve(import.meta.dirname, 'dist/template'),
				versions,
				preservePeerRanges: false,
			})
			if (plan.conflicts.length > 0) throw new Error(plan.conflicts.join('\n'))
			await applyCatalogSync(plan)
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

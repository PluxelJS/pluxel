import { glob, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig } from 'tsdown'

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
			const versions = new Map<string, string>()
			for await (const file of glob(
				['packages/*/package.json', 'plugins/*/package.json', 'plugins/*/*/package.json'],
				{
					cwd: repositoryRoot,
					exclude: ['**/node_modules/**', '**/dist/**'],
				},
			)) {
				const manifest = JSON.parse(await readFile(resolve(repositoryRoot, file), 'utf8'))
				if (!manifest.private && typeof manifest.version === 'string')
					versions.set(manifest.name, manifest.version)
			}
			const catalogFile = resolve(import.meta.dirname, 'dist/template/pnpm-workspace.yaml')
			const source = await readFile(catalogFile, 'utf8')
			const catalog = /^  pluxel:\n(?: {4}[^\n]*\n)+/m
			if (!catalog.test(source)) throw new Error('Starter template is missing its Pluxel catalog')
			await writeFile(
				catalogFile,
				source.replace(catalog, (block) =>
					block.replaceAll(/^(    '(@pluxel\/[^']+)': ).+$/gm, (_line, prefix, name) => {
						const version = versions.get(name)
						if (!version)
							throw new Error(`Starter catalog package has no publishable manifest: ${name}`)
						return `${prefix}^${version}`
					}),
				),
			)
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

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig } from 'vite-plus'
import lint from './oxlint.config'
import { readRepositoryPackages } from './scripts/repository-packages.mjs'

export default defineConfig(async () => {
	const inventory = await readRepositoryPackages()
	const packages = inventory
		.filter(({ kind }) => kind !== 'root')
		.map(({ manifest }) => ({ manifest }))
	for (const directory of [
		'vendor/eventure',
		'vendor/pncat',
		'vendor/split-like-vscode/packages/core',
		'vendor/split-like-vscode/packages/react',
	]) {
		packages.push({
			manifest: JSON.parse(
				await readFile(resolve(import.meta.dirname, directory, 'package.json'), 'utf8'),
			),
		})
	}
	// Explicit task edges avoid cycles in the publishing dependency graph.
	const tasks = Object.fromEntries(
		Object.entries({ build: 'compile', typecheck: 'check-types', test: 'check-tests' }).map(
			([script, task]) => [
				`workspace:${script}`,
				{
					command: script === 'build' ? 'node scripts/check-source-declarations.mjs' : [],
					cache: false,
					dependsOn: packages
						.filter(({ manifest }) => manifest.scripts?.[script])
						.map(({ manifest }) => `${manifest.name}#${task}`),
				},
			],
		),
	)
	Object.assign(tasks, {
		pncat: { command: 'node vendor/pncat/bin/pncat.mjs', cache: false },
		'catalog:check': {
			command: 'node packages/cli/bin/pluxel.mjs workspace sync --check',
			dependsOn: ['@pluxel/cli#compile'],
			cache: false,
		},
		'governance:check': {
			command:
				'vp test run --dir scripts repository-packages.test.mjs prepare-npm-publishing.test.mjs check-source-declarations.test.mjs && node scripts/check-repository-governance.mjs',
			dependsOn: ['catalog:check'],
			cache: false,
		},
		'source-declarations:check': {
			command: 'node scripts/check-source-declarations.mjs',
			cache: false,
		},
		'bench:core:compare': { command: 'scripts/core-bench-compare.sh', cache: false },
		tegami: { command: 'node scripts/tegami.mts', cache: false },
		'verify:checks': { command: 'vp check', cache: false },
		'workspace:verify': {
			command: 'node scripts/check-source-declarations.mjs',
			dependsOn: [
				'verify:checks',
				'governance:check',
				'workspace:build',
				'workspace:typecheck',
				'workspace:test',
			],
			cache: false,
		},
	})
	return {
		fmt: {
			useTabs: true,
			tabWidth: 2,
			printWidth: 100,
			singleQuote: true,
			jsxSingleQuote: false,
			quoteProps: 'as-needed',
			trailingComma: 'all',
			semi: false,
			arrowParens: 'always',
			bracketSameLine: false,
			bracketSpacing: true,
			ignorePatterns: [
				'dist/',
				'**/dist/',
				'coverage/',
				'vendor/',
				'**/*.hbs',
				'packages/core/benchmarks/',
				'packages/workbench/shell/src/app/router/routeTree.gen.ts',
				'projects/plugin-host/pluxel.loader.hmr.discovered.jsonc',
				'projects/docs/next-env.d.ts',
			],
		},
		lint,
		run: { cache: { scripts: false, tasks: true }, tasks },
	}
})

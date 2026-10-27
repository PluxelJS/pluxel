import { defineConfig, type UserConfig } from 'vite-plus'
import lint from './oxlint.config'
import fmt from './oxfmt.config'
import { repositoryPackages } from './scripts/repository-packages.mjs'

type Task = Exclude<NonNullable<NonNullable<UserConfig['run']>['tasks']>[string], string | string[]>

export default defineConfig(() => {
	const packages = repositoryPackages.filter(({ kind }) => kind !== 'root')
	// These tasks compile Typst's native binding or consume it in a full application.
	// Keep their complete build/test/typecheck path in workspace:verify for local use.
	const nativeConsumers = new Set([
		'@pluxel/plugin-typst',
		'@pluxel/plugin-takumi-markdown',
		'@pluxel/plugins-host',
		'@report-template-studio/app',
	])
	const ciPackages = packages.filter(({ manifest }) => !nativeConsumers.has(manifest.name))
	// Explicit task edges avoid cycles in the publishing dependency graph.
	const tasks: Record<string, Task> = {}
	for (const [scope, selected] of Object.entries({ workspace: packages, ci: ciPackages })) {
		for (const [script, task] of Object.entries({
			build: 'compile',
			typecheck: 'check-types',
			test: 'check-tests',
		})) {
			tasks[`${scope}:${script}`] = {
				command:
					script === 'build'
						? 'node scripts/check-source-declarations.mjs'
						: script === 'typecheck'
							? 'tsc --noEmit --pretty false -p scripts/tsconfig.json'
							: [],
				cache: false,
				dependsOn: selected
					.filter(({ manifest }) => manifest.scripts?.[script])
					.map(({ manifest }) => `${manifest.name}#${task}`),
			}
		}
	}
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
		'verify:checks': {
			command: 'vp check',
			// Typed lint consumes package declarations, including generated Plugin exports.
			dependsOn: ['workspace:build'],
			cache: false,
		},
		'workspace:verify': {
			command: [],
			dependsOn: [
				'verify:checks',
				'governance:check',
				'workspace:build',
				'workspace:typecheck',
				'workspace:test',
			],
			cache: false,
		},
		'ci:checks': {
			// Formatting remains repository-wide. Typed lint needs the selected package declarations.
			command: `vp fmt --check && vp lint --type-aware --type-check ${packages
				.filter(({ manifest }) => nativeConsumers.has(manifest.name))
				.map(({ directory }) => `--ignore-pattern '${directory}/**'`)
				.join(' ')}`,
			dependsOn: ['ci:build'],
			cache: false,
		},
		'ci:smoke': {
			dependsOn: ['@pluxel/plugin-typst#check-wasm'],
			command: [
				'vp test run --config vite.config.ts',
				'plugins/render/typst/tests/preview.test.ts',
				'plugins/render/typst/tests/source-navigation.test.ts',
				'projects/report-template-studio/tests/inputs.test.ts',
				'projects/report-template-studio/tests/discovery-acl.test.ts',
				'projects/report-template-studio/tests/electron-shutdown.test.ts',
			].join(' '),
			cache: false,
		},
		'workspace:ci': {
			command: [],
			dependsOn: [
				'ci:checks',
				'governance:check',
				'ci:build',
				'ci:typecheck',
				'ci:test',
				'ci:smoke',
			],
			cache: false,
		},
	} satisfies Record<string, Task>)
	return {
		fmt,
		lint,
		run: { cache: { scripts: false, tasks: true }, tasks },
	}
})

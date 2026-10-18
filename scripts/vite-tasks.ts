import type { UserConfig } from 'vite-plus'

type Task = Exclude<NonNullable<NonNullable<UserConfig['run']>['tasks']>[string], string | string[]>
type Cache = Exclude<Task['cache'], boolean | undefined>

// Shared workspace build constraints. Commands remain with their owning package.
// Preserve native observed inputs: Markdown, fixtures and templates can be build resources.
const defaults: Record<string, Partial<Task>> = {
	build: {
		dependsOn: [
			{
				task: 'build',
				from: ['dependencies', 'devDependencies', 'peerDependencies'],
			},
		],
		cache: {
			input: [
				{
					auto: true,
				},
				{
					pattern: 'tsconfig*.json',
					base: 'workspace',
				},
			],
			output: ['dist/**', 'public/**'],
		},
	},
	'build:lib': {
		dependsOn: [
			{
				task: 'build',
				from: ['dependencies', 'devDependencies', 'peerDependencies'],
			},
		],
		cache: {
			output: ['dist/**'],
		},
	},
	'build:web': {
		dependsOn: [],
		cache: {
			output: ['public/**'],
		},
	},
	'build:plugin': {
		dependsOn: [
			{
				task: 'build',
				from: ['dependencies', 'devDependencies', 'peerDependencies'],
			},
		],
		cache: {
			output: ['dist/**', 'public/**'],
		},
	},
	test: {
		dependsOn: [
			{
				task: 'build',
				from: ['dependencies', 'devDependencies', 'peerDependencies'],
			},
			'@pluxel/test#build',
		],
		cache: {
			input: [
				{
					auto: true,
				},
				{
					pattern: 'oxlint.config.ts',
					base: 'workspace',
				},
				{
					pattern: 'tsconfig*.json',
					base: 'workspace',
				},
			],
			output: [],
		},
	},
	typecheck: {
		dependsOn: [
			{
				task: 'build',
				from: ['dependencies', 'devDependencies', 'peerDependencies'],
			},
		],
		cache: {
			input: [
				{
					auto: true,
				},
				{
					pattern: 'tsconfig*.json',
					base: 'workspace',
				},
			],
			output: [],
		},
	},
}

const packages: Record<string, Partial<Task>> = {
	'@pluxel/async#test': {
		dependsOn: ['@pluxel/async#build', '@pluxel/test#build'],
	},
	'@pluxel/commands#build': {
		dependsOn: [],
		cache: {
			output: ['dist/**'],
		},
	},
	'@pluxel/typst#build': {
		cache: false,
	},
	'@pluxel/typst#test': {
		// Build and tests share the native compiler preparation lock.
		dependsOn: ['build', '@pluxel/test#build'],
	},
	'@pluxel/core#build': {
		dependsOn: ['@pluxel/context#build', 'eventure#build'],
		cache: {
			output: ['dist/**'],
		},
	},
	'valibot-form#build': {
		dependsOn: [],
		cache: {
			output: ['dist/**'],
		},
	},
	'@pluxel/rolldown#build': {
		dependsOn: ['@pluxel/core#build', 'valibot-form#build'],
		cache: {
			input: [
				{
					auto: true,
				},
				{
					pattern: 'tsconfig*.json',
					base: 'workspace',
				},
				{
					pattern: 'packages/workbench/package.json',
					base: 'workspace',
				},
				{
					pattern: 'packages/workbench/src/workbench/shared-transport.ts',
					base: 'workspace',
				},
				{
					pattern: 'packages/workbench/src/workbench/definition.ts',
					base: 'workspace',
				},
			],
			output: ['dist/**'],
		},
	},
	'@pluxel/test#build': {
		dependsOn: ['@pluxel/rolldown#build', '@pluxel/services#build', '@pluxel/workbench#build'],
		cache: {
			input: [
				{
					auto: true,
				},
			],
			output: ['dist/**'],
		},
	},
	'@pluxel/host-vite#build': {
		dependsOn: ['@pluxel/core#build', '@pluxel/host#build', '@pluxel/rolldown#build'],
		cache: {
			input: [
				{
					auto: true,
				},
			],
			output: ['dist/**'],
		},
	},
	'@pluxel/cli#build': {
		dependsOn: ['@pluxel/rolldown#build'],
		cache: {
			input: [
				{
					auto: true,
				},
				{
					pattern: 'docs/**',
					base: 'workspace',
				},
				{
					pattern: '.agents/skills/pluxel-development/**',
					base: 'workspace',
				},
				{
					pattern: 'pnpm-workspace.yaml',
					base: 'workspace',
				},
				{
					pattern: 'vendor/pncat/src/**',
					base: 'workspace',
				},
				{
					pattern: 'vendor/pncat/package.json',
					base: 'workspace',
				},
				{
					pattern: 'tsconfig.cli-build.json',
					base: 'workspace',
				},
				{
					pattern: 'vendor/pncat/LICENSE.md',
					base: 'workspace',
				},
				{
					pattern: 'vendor/pncat/UPSTREAM.md',
					base: 'workspace',
				},
			],
			output: ['dist/**'],
		},
	},
	'@pluxel/create#build': {
		dependsOn: ['@pluxel/cli#build'],
		cache: {
			input: [
				{
					auto: true,
				},
				{
					pattern: 'pnpm-workspace.yaml',
					base: 'workspace',
				},
				{
					pattern: 'packages/cli/scripts/dependency-policy.*',
					base: 'workspace',
				},
				{
					pattern: 'packages/*/package.json',
					base: 'workspace',
				},
				{
					pattern: 'plugins/**/package.json',
					base: 'workspace',
				},
				{
					pattern: 'docs/**',
					base: 'workspace',
				},
			],
			output: ['dist/**'],
		},
	},
	'pluxel-docs#build': {
		dependsOn: ['prepare:docs'],
		cache: {
			input: [
				{
					auto: true,
				},
				{
					pattern: 'docs/**',
					base: 'workspace',
				},
			],
			output: ['dist/**', '.source/**', '.vercel/output/**'],
			env: ['VERCEL*'],
		},
	},
	'@pluxel/redis#test': {
		dependsOn: [
			{
				task: 'build',
				from: ['dependencies', 'devDependencies', 'peerDependencies'],
			},
		],
		// Redis availability and state are external inputs that a file cache cannot validate.
		cache: false,
	},
	'@pluxel/cli#test': {
		dependsOn: [
			{
				task: 'build',
				from: ['dependencies', 'devDependencies', 'peerDependencies'],
			},
			'build',
		],
	},
	'@pluxel/package-manager#test': {
		// The optional registry integration observes external state.
		cache: false,
		dependsOn: [
			{
				task: 'build',
				from: ['dependencies', 'devDependencies', 'peerDependencies'],
			},
			'build',
			'@pluxel/test#build',
		],
	},
	'@pluxel/plugins-host#test': {
		dependsOn: [
			{
				task: 'build',
				from: ['dependencies', 'devDependencies', 'peerDependencies'],
			},
			'build',
			'@pluxel/test#build',
		],
	},
	'@pluxel/create#test': {
		dependsOn: [
			{
				task: 'build',
				from: ['dependencies', 'devDependencies', 'peerDependencies'],
			},
			'build',
			'@pluxel/test#build',
		],
	},
	'@pluxel/host-vite#test': {
		dependsOn: [
			{
				task: 'build',
				from: ['dependencies', 'devDependencies', 'peerDependencies'],
			},
			'build',
			'@pluxel/host#build',
			'@pluxel/test#build',
		],
	},
	'@pluxel/rolldown#test': {
		dependsOn: [
			{
				task: 'build',
				from: ['dependencies', 'devDependencies', 'peerDependencies'],
			},
		],
	},
	'@pluxel/plugins-host#typecheck': {
		cache: {
			input: [
				{
					auto: true,
				},
				{
					pattern: 'tsconfig*.json',
					base: 'workspace',
				},
			],
		},
	},
	'@pluxel/services#build': {
		dependsOn: ['@pluxel/commands#build', '@pluxel/host#build', '@pluxel/host-vite#build'],
		cache: {
			input: [
				{
					auto: true,
				},
				{
					pattern: 'tsconfig*.json',
					base: 'workspace',
				},
				{
					pattern: 'packages/workbench/package.json',
					base: 'workspace',
				},
				{
					pattern: 'packages/workbench/tsconfig.json',
					base: 'workspace',
				},
				{
					pattern: 'packages/workbench/src/**',
					base: 'workspace',
				},
			],
		},
	},
	'@pluxel/workbench#build:lib': {
		dependsOn: ['build:web'],
	},
	'@pluxel/workbench#build:web': {
		dependsOn: [
			'@pluxel/services#build',
			'@pluxel/rolldown#build',
			'@worksplit/react#build',
			'valibot-form#build',
		],
	},
	'@pluxel/workbench#build': {
		dependsOn: ['build:lib'],
		cache: {
			output: [],
			input: [
				{
					auto: true,
				},
			],
		},
	},
	'@pluxel/host#build': {
		dependsOn: ['@pluxel/core#build'],
		cache: {
			output: ['dist/**'],
		},
	},
}

const taskNames: Record<string, string> = {
	build: 'compile',
	test: 'check-tests',
	typecheck: 'check-types',
	'build:web': 'compile-web',
	'build:lib': 'compile-lib',
	'build:plugin': 'compile-plugin',
}

export function repositoryTasks(name: string, commands: Record<string, string>) {
	const tasks: Record<string, Task> = {}
	for (const [script, command] of Object.entries(commands)) {
		const base = defaults[script] ?? {}
		const specific = packages[`${name}#${script}`] ?? {}
		const cache: Cache | false =
			specific.cache === false
				? false
				: {
						...(typeof base.cache === 'object' ? base.cache : {}),
						...(typeof specific.cache === 'object' ? specific.cache : {}),
					}
		if (cache !== false) {
			cache.env = [...new Set(['NODE_ENV', 'CI', ...(cache.env ?? [])])]
			cache.input = [
				...(cache.input ?? [{ auto: true }]),
				{ pattern: '!**/node_modules/.vite/**', base: 'workspace' },
				{ pattern: '!**/node_modules/.vitest-cache/**', base: 'workspace' },
				{ pattern: 'mise.toml', base: 'workspace' },
				{ pattern: 'scripts/vite-tasks.ts', base: 'workspace' },
				{ pattern: 'scripts/pack.mjs', base: 'workspace' },
			]
			cache.untrackedEnv = [
				'CHOKIDAR_USEPOLLING',
				'PNPM_CONFIG_PM_ON_FAIL',
				'PNPM_CONFIG_WORKSPACE_DIR',
			]
		}
		const dependsOn = (specific.dependsOn ?? base.dependsOn ?? []).map((dependency) => {
			if (typeof dependency !== 'string')
				return Object.assign({}, dependency, {
					task: taskNames[dependency.task] ?? dependency.task,
				})
			const separator = dependency.lastIndexOf('#')
			const task = dependency.slice(separator + 1)
			return dependency.slice(0, separator + 1) + (taskNames[task] ?? task)
		})
		tasks[taskNames[script] ?? script] = { ...base, ...specific, dependsOn, command, cache }
	}
	return tasks
}

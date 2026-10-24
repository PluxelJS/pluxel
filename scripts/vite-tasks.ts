import type { UserConfig } from 'vite-plus'

type Task = Exclude<NonNullable<NonNullable<UserConfig['run']>['tasks']>[string], string | string[]>
type Cache = Exclude<Task['cache'], boolean | undefined>

// Package-specific commands, dependency edges and outputs belong in each vite.config.ts.
// This helper only supplies the shared workspace defaults, using native task names.
const dependencyBuilds = [
	{ task: 'compile', from: ['dependencies', 'devDependencies', 'peerDependencies'] },
] satisfies Task['dependsOn']

const defaults: Record<string, Partial<Task>> = {
	compile: { dependsOn: dependencyBuilds, cache: { output: ['dist/**', 'public/**'] } },
	'compile-lib': { dependsOn: dependencyBuilds, cache: { output: ['dist/**'] } },
	'compile-web': { cache: { output: ['public/**'] } },
	'compile-plugin': { dependsOn: dependencyBuilds, cache: { output: ['dist/**', 'public/**'] } },
	'check-tests': {
		dependsOn: [...dependencyBuilds, '@pluxel/test#compile'],
		cache: { output: [] },
	},
	'check-types': { dependsOn: dependencyBuilds, cache: { output: [] } },
}

export function repositoryTasks(definitions: Record<string, string | Task>) {
	const tasks: Record<string, Task> = {}
	for (const [name, definition] of Object.entries(definitions)) {
		const task = typeof definition === 'string' ? { command: definition } : definition
		const base = defaults[name] ?? {}
		const baseCache = typeof base.cache === 'object' ? base.cache : {}
		const overrides = typeof task.cache === 'object' ? task.cache : {}
		const cache: Cache | false =
			task.cache === false
				? false
				: {
						...baseCache,
						...overrides,
						input: [
							{ auto: true },
							{ pattern: 'tsconfig*.json', base: 'workspace' },
							...(name === 'check-tests'
								? [{ pattern: 'oxlint.config.ts', base: 'workspace' as const }]
								: []),
							...(overrides.input ?? []),
							{ pattern: '!**/node_modules/.vite/**', base: 'workspace' },
							{ pattern: '!**/node_modules/.vitest-cache/**', base: 'workspace' },
							{ pattern: 'mise.toml', base: 'workspace' },
							{ pattern: 'scripts/vite-tasks.ts', base: 'workspace' },
							{ pattern: 'scripts/pack.mjs', base: 'workspace' },
						],
						env: [...new Set(['NODE_ENV', 'CI', ...(overrides.env ?? [])])],
						untrackedEnv: [
							'CHOKIDAR_USEPOLLING',
							'PNPM_CONFIG_PM_ON_FAIL',
							'PNPM_CONFIG_WORKSPACE_DIR',
						],
					}
		tasks[name] = { ...base, ...task, dependsOn: task.dependsOn ?? base.dependsOn ?? [], cache }
	}
	return tasks
}

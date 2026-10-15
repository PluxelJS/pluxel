import type { UserConfig } from 'vite-plus'

type Task = Exclude<NonNullable<NonNullable<UserConfig['run']>['tasks']>[string], string | string[]>

export const checkCache = {
	input: [
		{ auto: true },
		{ pattern: 'tsconfig.base.json', base: 'workspace' },
		{ pattern: 'mise.toml', base: 'workspace' },
	],
	env: ['CI', 'NODE_ENV'],
	output: [],
} satisfies Exclude<Task['cache'], boolean | undefined>

/** Build dependencies before their consumers. */
export function buildTask(command: string): Task {
	return {
		command,
		dependsOn: [{ task: 'compile', from: ['dependencies', 'devDependencies', 'peerDependencies'] }],
		cache: { ...checkCache, output: ['dist/**', 'web/dist/**'] },
	}
}

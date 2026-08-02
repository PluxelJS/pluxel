import { resolve } from 'node:path'
import { definePluxelVitestConfig } from '@pluxel/test/vitest'

type WorkspaceKind = 'packages' | 'platforms' | 'plugins'

const workspaceAlias = (kind: WorkspaceKind, name: string) => ({
	find: new RegExp(`^@repo/chatbots-${name}$`),
	replacement: resolve(import.meta.dirname, `${kind}/${name}/src/index.ts`),
})

const workspaceSubpathAlias = (kind: WorkspaceKind, name: string) => ({
	find: new RegExp(`^@repo/chatbots-${name}/(.+)$`),
	replacement: resolve(import.meta.dirname, `${kind}/${name}/src/$1.ts`),
})

export default definePluxelVitestConfig(
	{
		root: import.meta.dirname,
		resolve: {
			alias: [
				workspaceAlias('plugins', 'access'),
				workspaceSubpathAlias('packages', 'platform-kit'),
				workspaceSubpathAlias('packages', 'workbench-support'),
				workspaceAlias('packages', 'contracts'),
				workspaceAlias('plugins', 'hub'),
				workspaceAlias('plugins', 'commands'),
				workspaceAlias('platforms', 'discord'),
				workspaceAlias('platforms', 'kook'),
				workspaceAlias('platforms', 'kook-hub-bridge'),
				workspaceAlias('platforms', 'telegram'),
				workspaceAlias('platforms', 'telegram-hub-bridge'),
			],
		},
		oxc: {
			decorator: {
				legacy: true,
			},
		},
		test: {
			include: [
				'packages/*/tests/**/*.test.ts',
				'platforms/*/tests/**/*.test.ts',
				'plugins/*/tests/**/*.test.ts',
				'test/**/*.test.ts',
			],
		},
	},
	{
		include: ['packages/**/src/**/*.ts', 'packages/**/tests/**/*.ts', 'platforms/**/src/**/*.ts'],
	},
)

import { resolve } from 'node:path'
import { definePluxelVitestConfig } from '@pluxel/test/vitest'

const workspaceAlias = (kind: 'packages' | 'plugins', name: string) => ({
	find: new RegExp(`^@repo/chatbots-${name}$`),
	replacement: resolve(import.meta.dirname, `${kind}/${name}/src/index.ts`),
})

const workspaceSubpathAlias = (kind: 'packages' | 'plugins', name: string) => ({
	find: new RegExp(`^@repo/chatbots-${name}/(.+)$`),
	replacement: resolve(import.meta.dirname, `${kind}/${name}/src/$1.ts`),
})

export default definePluxelVitestConfig({
	root: import.meta.dirname,
	resolve: {
		alias: [
			workspaceAlias('plugins', 'access'),
			workspaceSubpathAlias('packages', 'platform-kit'),
			workspaceSubpathAlias('packages', 'workbench-support'),
			workspaceAlias('packages', 'contracts'),
			workspaceAlias('plugins', 'hub'),
			workspaceAlias('plugins', 'commands'),
			workspaceAlias('plugins', 'kook'),
			workspaceAlias('plugins', 'kook-hub-bridge'),
			workspaceAlias('plugins', 'telegram'),
			workspaceAlias('plugins', 'telegram-hub-bridge'),
		],
	},
	oxc: {
		decorator: {
			legacy: true,
		},
	},
	test: {
		include: ['packages/*/tests/**/*.test.ts', 'plugins/*/tests/**/*.test.ts', 'test/**/*.test.ts'],
	},
})

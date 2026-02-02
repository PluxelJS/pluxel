import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import GraphQL from '@pluxel/graphql'
import { startHmrHost } from '@pluxel/hmr/host'
import { MarketUI } from 'pluxel-plugin-market-ui'
import Snapshot from '@pluxel/snapshot'
import Wretch from '@pluxel/wretch'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
process.chdir(repoRoot)

const HOST_EXCLUDE = [
	'packages/plugins/host/src/demo/**/ui/**',
	'packages/plugins/host/src/demo/env.ts',
] as const

const BUILTINS_ENABLED =
	process.env.PLUXEL_PLUGINS_HOST_BUILTINS === '0' || process.env.PLUXEL_PLUGINS_HOST_BUILTINS === 'false'
		? false
		: true

const activeProfile = process.env.PLUXEL_HMR_PROFILE ?? 'plugins-host'

const configPath = process.env.PLUXEL_HMR_CONFIG ?? 'pluxel.hmr.jsonc'

const { ctx } = await startHmrHost({
	root: repoRoot,
	profile: activeProfile,
	configPath,
	logsDir: 'packages/plugins/host/logs',
	// Keep demo host quiet: exclude UI demo sources by default.
	exclude: [...HOST_EXCLUDE],
	builtins: BUILTINS_ENABLED
		? [
				{ plugin: GraphQL, packageName: '@pluxel/graphql', exportKey: 'default' },
				{ plugin: Snapshot, packageName: '@pluxel/snapshot', exportKey: 'default' },
				{ plugin: MarketUI, packageName: 'pluxel-plugin-market-ui', exportKey: 'MarketUI' },
				{ plugin: Wretch, packageName: '@pluxel/wretch', exportKey: 'default' },
			]
		: [],
})

ctx.logger.info`HMR host ready (profile=${activeProfile}, builtins=${BUILTINS_ENABLED})`

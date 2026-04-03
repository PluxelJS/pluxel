import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'pathe'

import { bootPlannedHmrHost, planHmrHostFromConfig } from '@pluxel/hmr/host'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
process.chdir(repoRoot)

const activeProfile = process.env.PLUXEL_HMR_PROFILE ?? 'plugins-host'

const configPath = process.env.PLUXEL_HMR_CONFIG ?? 'packages/plugins/host/pluxel.hmr.jsonc'

const plan = await planHmrHostFromConfig({
	root: repoRoot,
	logsDir: 'packages/plugins/host/logs',
	chdir: false,
	configPath,
	profile: activeProfile,
})
const { ctx, hmr } = await bootPlannedHmrHost(plan)
await hmr.start()

ctx.logger.info`HMR host ready (profile=${activeProfile})`

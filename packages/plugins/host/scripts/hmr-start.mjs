import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'pathe'

import { startHmrHostFromConfig } from '@pluxel/hmr/host'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
process.chdir(repoRoot)

const activeProfile = process.env.PLUXEL_HMR_PROFILE ?? 'plugins-host'

const configPath = process.env.PLUXEL_HMR_CONFIG ?? 'packages/plugins/host/pluxel.hmr.jsonc'

const { ctx } = await startHmrHostFromConfig({
	root: repoRoot,
	logsDir: 'packages/plugins/host/logs',
	chdir: false,
	configPath,
	profile: activeProfile,
})

ctx.logger.info`HMR host ready (profile=${activeProfile})`

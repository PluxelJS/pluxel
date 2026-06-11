import { fileURLToPath } from 'node:url'
import { createLoaderHmrHost, defineLoaderHmrConfig } from '@pluxel/runtime-dynamic/hmr'
import { dirname, resolve } from 'pathe'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
process.chdir(repoRoot)

const activeProfile = process.env.PLUXEL_HMR_PROFILE ?? 'plugins-host'
const configPath = process.env.PLUXEL_HMR_CONFIG ?? 'packages/plugins/host/pluxel.loader.hmr.jsonc'

const host = await createLoaderHmrHost({
	config: defineLoaderHmrConfig({
		root: repoRoot,
		logsDir: 'packages/plugins/host/logs',
		chdir: false,
		configPath,
		profile: activeProfile,
	}),
})

await host.start()
host.ctx.logger.info`Loader HMR host ready (profile=${activeProfile})`

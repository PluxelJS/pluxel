import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHmrHost } from '@pluxel/hmr/host'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
process.chdir(repoRoot)

const HOST_EXCLUDE = [
	'packages/plugins/host/src/demo/**/ui/**',
	'packages/plugins/host/src/demo/env.ts',
] as const

const activeProfile = process.env.PLUXEL_HMR_PROFILE ?? 'plugins-host'

const configPath = process.env.PLUXEL_HMR_CONFIG ?? 'pluxel.hmr.jsonc'

const { ctx } = await startHmrHost({
	root: repoRoot,
	profile: activeProfile,
	configPath,
	logsDir: 'packages/plugins/host/logs',
	// Keep demo host quiet: exclude UI demo sources by default.
	exclude: [...HOST_EXCLUDE],
	// Builtins are declared in workspace profiles (pluxel.hmr.jsonc).
})

ctx.logger.info`HMR host ready (profile=${activeProfile})`

import { dirname, resolve } from 'pathe'
import { fileURLToPath } from 'node:url'
import { startHmrHost } from '@pluxel/hmr/host'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
process.chdir(repoRoot)

const uniqSorted = (list: readonly string[]) =>
	[...new Set(list.map((s) => String(s).trim()).filter(Boolean))].sort((a, b) =>
		a.localeCompare(b),
	)

const HOST_EXCLUDE = [
	'packages/plugins/host/src/demo/**/ui/**',
	'packages/plugins/host/src/demo/env.ts',
] as const

const activeProfile = process.env.PLUXEL_HMR_PROFILE ?? 'plugins-host'

const configPath = process.env.PLUXEL_HMR_CONFIG ?? 'pluxel.hmr.jsonc'

const { ctx } = await startHmrHost({
	root: repoRoot,
	logsDir: 'packages/plugins/host/logs',
	chdir: false,
	configPath,
	profile: activeProfile,
	snapshotPatch: (snapshot) => ({
		...snapshot,
		// Keep demo host quiet: exclude UI demo sources by default.
		excludeGlobs: uniqSorted([...snapshot.excludeGlobs, ...HOST_EXCLUDE]),
	}),
})

ctx.logger.info`HMR host ready (profile=${activeProfile})`

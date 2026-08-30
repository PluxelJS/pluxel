import { fileURLToPath } from 'node:url'
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'
import { dirname, resolve } from 'pathe'
import {
	createHostConfigRecords,
	createHostRuntimeState,
	hostManagement,
	product,
} from './showcase/policy'

export { product }

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const activeProfile = process.env.PLUXEL_HMR_PROFILE ?? 'plugins-host'
const configPath = process.env.PLUXEL_HMR_CONFIG ?? 'projects/plugin-host/pluxel.loader.hmr.jsonc'

export default defineDynamicRuntimeConfig({
	root: repoRoot,
	configPath,
	profile: activeProfile,
	logsDir: 'projects/plugin-host/logs',
	sources: [
		{
			kind: 'directory',
			path: '.pluxel/managed-plugins/entries',
			include: ['*.mjs'],
		},
	],
	configService: {
		mode: 'memory',
		snapshot: { plugins: createHostConfigRecords() },
	},
	runtimeState: { mode: 'memory', snapshot: createHostRuntimeState(true) },
	management: hostManagement,
	workbench: { enabled: true },
	vault: {},
})

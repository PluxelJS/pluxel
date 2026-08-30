import { fileURLToPath } from 'node:url'
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'
import { dirname, resolve } from 'pathe'
import {
	createHostConfigRecords,
	createHostRuntimeState,
	packageManagerNode,
	product,
} from './showcase/policy'

export { product }

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const managedPackagesRoot = resolve(repoRoot, '.pluxel/managed-plugins')
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
			path: resolve(managedPackagesRoot, 'entries'),
			include: ['*.mjs'],
		},
	],
	configService: {
		mode: 'memory',
		snapshot: {
			plugins: [
				...createHostConfigRecords(resolve(repoRoot, '.pluxel/showcase/s3')),
				{ owner: packageManagerNode, config: { rootDir: managedPackagesRoot } },
			],
		},
	},
	runtimeState: { mode: 'memory', snapshot: createHostRuntimeState(true) },
	workbench: { enabled: true },
	vault: {},
})

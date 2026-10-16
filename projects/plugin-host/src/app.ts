import { pluginSource } from '@pluxel/host/sources'
import { defineHostApplication } from '@pluxel/host'
import { resolveHostEnv } from '@pluxel/host/environment'
import { servicesPreset } from '@pluxel/services/preset'

import { resolve } from 'pathe'
import { hostPlugins } from './showcase/catalog'
import {
	createHostConfigRecords,
	createHostRuntimeState,
	packageManagerNode,
	product,
} from './showcase/policy'

export { product }

export default defineHostApplication(async (startup) => {
	const environment = resolveHostEnv(startup.env)
	const dataRoot = resolve(startup.deployment?.root ?? startup.root, environment.dataRoot)
	const managedPackagesRoot = resolve(dataRoot, 'managed-plugins')
	return {
		name: 'pluxel-architecture-lab',
		plugins: hostPlugins,
		// Development starts compile the official Node artifacts on the same lifecycle path.
		config: { plugins: { startTimeoutMs: 30_000 } },
		sources: [
			pluginSource({
				kind: 'directory',
				path: resolve(managedPackagesRoot, 'entries'),
				include: ['*.mjs'],
			}),
		],
		services: await servicesPreset(startup, {
			persistence: resolve(dataRoot, 'persistence'),
			product,
			workbench: environment.workbench ?? true,
		}),
		configRecords: {
			mode: 'memory',
			initial: [
				...createHostConfigRecords(resolve(dataRoot, 'showcase/s3')),
				{ owner: packageManagerNode, config: { rootDir: managedPackagesRoot } },
			],
		},
		state: { mode: 'memory', initial: createHostRuntimeState() },
	}
})

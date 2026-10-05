import { pluginSource } from '@pluxel/host/sources'
import { defineHostApplication } from '@pluxel/host'
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
	const dataRoot = resolve(
		startup.deployment?.root ?? startup.root,
		startup.env.PLUXEL_DATA_ROOT ?? '.pluxel',
	)
	const managedPackagesRoot = resolve(dataRoot, 'managed-plugins')
	const { env } = startup
	const withWorkbench = env.PLUXEL_WORKBENCH !== 'false'
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
			workbench: withWorkbench,
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

import { dynamicSource } from '@pluxel/host/dynamic'
import { defineConfig } from '@pluxel/host'
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

export default defineConfig(async (startup) => {
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
		sources: [
			dynamicSource({
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

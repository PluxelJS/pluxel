import { dynamicSource } from '@pluxel/host-dynamic'
import type { HostApplication } from '@pluxel/host'
import { servicesPreset } from '@pluxel/services'

import { resolve } from 'pathe'
import { hostPlugins } from './showcase/catalog'
import {
	createHostConfigRecords,
	createHostRuntimeState,
	packageManagerNode,
	product,
} from './showcase/policy'

export { product }

const dataRoot = resolve(process.cwd(), process.env.PLUXEL_DATA_ROOT ?? '.pluxel')
const managedPackagesRoot = resolve(dataRoot, 'managed-plugins')

export default {
	name: 'pluxel-architecture-lab',
	plugins: hostPlugins,
	sources: [
		dynamicSource({
			kind: 'directory',
			path: resolve(managedPackagesRoot, 'entries'),
			include: ['*.mjs'],
		}),
	],
	async configure(startup) {
		const { env } = startup
		const withWorkbench = env.PLUXEL_WORKBENCH !== 'false'
		return {
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
	},
} satisfies HostApplication

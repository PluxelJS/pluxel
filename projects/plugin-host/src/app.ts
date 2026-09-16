import { dynamicSource } from '@pluxel/host-dynamic'
import type { RuntimeApplication } from '@pluxel/runtime'
import { resolveHostEnv } from '@pluxel/runtime/environment'
import { resolve } from 'pathe'
import { hostPlugins } from './showcase/catalog'
import {
	createHostConfigRecords,
	createHostRuntimeState,
	packageManagerNode,
	product,
} from './showcase/policy'

export { product }

const dataRoot = resolve(process.cwd(), resolveHostEnv().dataRoot)
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
	configure() {
		return {
			configService: {
				mode: 'memory',
				snapshot: {
					plugins: [
						...createHostConfigRecords(resolve(dataRoot, 'showcase/s3')),
						{ owner: packageManagerNode, config: { rootDir: managedPackagesRoot } },
					],
				},
			},
			runtimeState: { mode: 'memory', snapshot: createHostRuntimeState() },
			workbench: { enabled: true, uiBasePath: '/__pluxel/workbench' },
			persistence: resolve(dataRoot, 'persistence'),
			vault: {},
		}
	},
} satisfies RuntimeApplication

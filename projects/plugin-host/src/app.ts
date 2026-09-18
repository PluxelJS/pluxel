import { dynamicSource } from '@pluxel/host-dynamic'
import type { HostApplication } from '@pluxel/host'
import { standardServices } from '@pluxel/services'
import { logging } from '@pluxel/logging'
import { vault } from '@pluxel/services/vault'
import { managementAccess } from '@pluxel/management/access'
import { management } from '@pluxel/management/service'
import { workbenchService } from '@pluxel/workbench/service'
import { workbenchHttp } from '@pluxel/workbench/http'

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
	configure({ env, deployment }) {
		const withWorkbench = env.PLUXEL_WORKBENCH !== 'false'
		return {
			services: [
				logging({
					root: { profile: 'pluxel-architecture-lab' },
					sinks: {
						console: { kind: 'console', format: 'pretty', caller: false, timezone: 'local' },
						store: { kind: 'store', streamId: 'default', caller: true },
					},
					routes: {
						runtime: [
							{ sink: 'console', minLevel: 'info' },
							{ sink: 'store', minLevel: 'trace' },
						],
						plugins: [
							{ sink: 'console', minLevel: 'trace' },
							{ sink: 'store', minLevel: 'trace' },
						],
						debug: [
							{ sink: 'console', minLevel: 'trace' },
							{ sink: 'store', minLevel: 'trace' },
						],
						meta: [{ sink: 'console', minLevel: 'warning' }],
					},
				}),
				...standardServices({
					persistence: resolve(dataRoot, 'persistence'),
					nodeModules: deployment
						? { root: resolve(deployment.root, 'artifacts/node') }
						: undefined,
				}),
				vault(),
				managementAccess(),
				management({ application: { product }, workbench: withWorkbench }),
				...(withWorkbench
					? [
							workbenchService({
								product,
								artifacts: deployment ? { root: resolve(deployment.root, 'workbench') } : undefined,
							}),
							workbenchHttp({
								uiBasePath: '/__pluxel/workbench',
								publicDir: deployment ? resolve(deployment.root, 'workbench/public') : undefined,
							}),
						]
					: []),
			],
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

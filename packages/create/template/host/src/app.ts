import type { HostApplication } from '@pluxel/host'
import { standardServices } from '@pluxel/services'
import { logging } from '@pluxel/logging'
import { vault } from '@pluxel/services/vault'
import { managementAccess } from '@pluxel/management/access'
import { management } from '@pluxel/management/service'
import { workbenchService } from '@pluxel/workbench/service'
import { workbenchHttp } from '@pluxel/workbench/http'

import { dynamicSource } from '@pluxel/host-dynamic'
import { resolve } from 'node:path'
import { product } from './product'
import { exampleConfigRecords, examplePlugins, exampleHostState } from './runtime-state'

export { product }

const dataRoot = resolve(process.cwd(), process.env.PLUXEL_DATA_ROOT ?? '.pluxel')

export default {
	name: 'pluxel-example',
	plugins: examplePlugins,
	sources: [
		dynamicSource({
			kind: 'directory',
			path: resolve(dataRoot, 'managed-plugins'),
			include: ['*.mjs'],
		}),
	],
	configure({ env, deployment }) {
		const withWorkbench = env.PLUXEL_WORKBENCH !== 'false'
		return {
			services: [
				logging({
					root: { profile: 'pluxel-example' },
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
			configRecords: exampleConfigRecords(env.EXAMPLE_TODO_MAX_ITEMS),
			state: exampleHostState(),
		}
	},
} satisfies HostApplication

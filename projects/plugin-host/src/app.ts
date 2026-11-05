import * as nativeFs from 'node:fs'
import { pluginSource } from '@pluxel/host/sources'
import { defineHostApplication } from '@pluxel/host'
import { resolveHostEnv } from '@pluxel/host/environment'
import { servicesPreset } from '@pluxel/services/preset'
import { listenElysia } from '@pluxel/services/elysia/node'
import { Passthrough } from '@pluxel/core/fs'
import { logtape, zenfs } from '@pluxel/core/config'

import { resolve } from 'pathe'
import { hostPlugins } from './showcase/catalog'
import {
	createHostConfigRecords,
	createHostPolicy,
	packageManagerNode,
	product,
} from './showcase/policy'

export { product }

export default defineHostApplication(async (startup) => {
	const environment = resolveHostEnv(startup.env)
	const dataRoot = resolve(startup.deployment?.root ?? startup.root, environment.dataRoot)
	const managedPackagesRoot = resolve(dataRoot, 'managed-plugins')
	const prefix = resolve(dataRoot, 'fs')
	await nativeFs.promises.mkdir(prefix, { recursive: true })
	return {
		name: 'pluxel-architecture-lab',
		plugins: hostPlugins,
		sources: [
			pluginSource({
				kind: 'directory',
				path: resolve(managedPackagesRoot, 'entries'),
				include: ['*.mjs'],
			}),
		],
		services: await servicesPreset(startup, {
			product,
			workbench: environment.workbench ?? true,
			initialShortcuts: [{ target: packageManagerNode, entryKey: 'marketplace' }],
		}),
		async launch({ host }) {
			await listenElysia(host, {
				hostname: environment.hostBind,
				port: environment.hostPort,
				publicOrigin: environment.publicOrigin,
				publicDir: resolve(startup.deployment?.root ?? startup.root, 'public'),
			})
		},
		config: {
			mode: 'saved-first',
			records: [
				...createHostConfigRecords(resolve(dataRoot, 'showcase/s3')),
				{ owner: packageManagerNode, config: { rootDir: managedPackagesRoot } },
			],
		},
		policy: {
			startTimeoutMs: 30_000,
			mode: { autoStart: 'saved-first', providerDefaults: 'saved-first' },
			...createHostPolicy(),
		},
		runtime: {
			logtape: logtape(),
			zenfs: zenfs({
				mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
				durableMounts: ['/'],
			}),
		},
	}
})

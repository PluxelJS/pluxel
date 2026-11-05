import * as nativeFs from 'node:fs'
import { defineHostApplication } from '@pluxel/host'
import { resolveHostEnv } from '@pluxel/host/environment'
import { servicesPreset } from '@pluxel/services/preset'
import { listenElysia } from '@pluxel/services/elysia/node'
import { Passthrough } from '@pluxel/core/fs'
import { logtape, zenfs } from '@pluxel/core/config'

import { pluginSource } from '@pluxel/host/sources'
import { resolve } from 'node:path'
import { product } from './product'
import { exampleHostConfig, examplePlugins, exampleHostPolicy } from './policy'

export { product }

export default defineHostApplication(async (startup) => {
	const environment = resolveHostEnv(startup.env)
	const dataRoot = resolve(startup.deployment?.root ?? startup.root, environment.dataRoot)
	const { env } = startup
	const prefix = resolve(dataRoot, 'fs')
	await nativeFs.promises.mkdir(prefix, { recursive: true })
	return {
		name: 'pluxel-example',
		plugins: examplePlugins,
		sources: [
			pluginSource({
				kind: 'directory',
				path: resolve(dataRoot, 'managed-plugins/entries'),
				include: ['*.mjs'],
			}),
		],
		services: await servicesPreset(startup, {
			product,
			workbench: environment.workbench ?? true,
		}),
		async launch({ host }) {
			await listenElysia(host, {
				hostname: environment.hostBind,
				port: environment.hostPort,
				publicOrigin: environment.publicOrigin,
				publicDir: resolve(startup.deployment?.root ?? startup.root, 'public'),
			})
		},
		config: exampleHostConfig(env.EXAMPLE_TODO_MAX_ITEMS),
		policy: exampleHostPolicy(),
		runtime: {
			logtape: logtape(),
			zenfs: zenfs({
				mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
				durableMounts: ['/'],
			}),
		},
	}
})

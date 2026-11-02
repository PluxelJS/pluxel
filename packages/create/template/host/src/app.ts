import * as nativeFs from 'node:fs'
import { defineHostApplication } from '@pluxel/host'
import { resolveHostEnv } from '@pluxel/host/environment'
import { servicesPreset } from '@pluxel/services/preset'
import { Passthrough } from '@pluxel/core/fs'
import { logtape, zenfs } from '@pluxel/core/config'

import { pluginSource } from '@pluxel/host/sources'
import { resolve } from 'node:path'
import { product } from './product'
import { exampleConfigRecords, examplePlugins, exampleHostState } from './runtime-state'

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
		runtime: {
			logtape: logtape(),
			zenfs: zenfs({
				mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
				durableMounts: ['/'],
			}),
			configRecords: exampleConfigRecords(env.EXAMPLE_TODO_MAX_ITEMS),
			state: exampleHostState(),
		},
	}
})

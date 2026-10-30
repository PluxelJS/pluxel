import * as nativeFs from 'node:fs'
import { defineHostApplication } from '@pluxel/host'
import { resolveHostEnv } from '@pluxel/host/environment'
import { servicesPreset } from '@pluxel/services/preset'
import { Passthrough } from '@pluxel/services/fs'

import { pluginSource } from '@pluxel/host/sources'
import { resolve } from 'node:path'
import { product } from './product'
import { exampleConfigRecords, examplePlugins, exampleHostState } from './runtime-state'

export { product }

export default defineHostApplication(async (startup) => {
	const environment = resolveHostEnv(startup.env)
	const dataRoot = resolve(startup.deployment?.root ?? startup.root, environment.dataRoot)
	const { env } = startup
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
			fs: { backend: Passthrough, fs: nativeFs, prefix: resolve(dataRoot, 'fs') },
			product,
			workbench: environment.workbench ?? true,
		}),
		configRecords: exampleConfigRecords(env.EXAMPLE_TODO_MAX_ITEMS),
		state: exampleHostState(),
	}
})

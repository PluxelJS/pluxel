import { defineHostApplication } from '@pluxel/host'
import { servicesPreset } from '@pluxel/services/preset'

import { dynamicSource } from '@pluxel/host/dynamic'
import { resolve } from 'node:path'
import { product } from './product'
import { exampleConfigRecords, examplePlugins, exampleHostState } from './runtime-state'

export { product }

export default defineHostApplication(async (startup) => {
	const dataRoot = resolve(
		startup.deployment?.root ?? startup.root,
		startup.env.PLUXEL_DATA_ROOT ?? '.pluxel',
	)
	const { env } = startup
	const withWorkbench = env.PLUXEL_WORKBENCH !== 'false'
	return {
		name: 'pluxel-example',
		plugins: examplePlugins,
		sources: [
			dynamicSource({
				kind: 'directory',
				path: resolve(dataRoot, 'managed-plugins'),
				include: ['*.mjs'],
			}),
		],
		services: await servicesPreset(startup, {
			persistence: resolve(dataRoot, 'persistence'),
			product,
			workbench: withWorkbench,
		}),
		configRecords: exampleConfigRecords(env.EXAMPLE_TODO_MAX_ITEMS),
		state: exampleHostState(),
	}
})

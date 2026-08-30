import { resolve } from 'node:path'
import { defineStaticRuntime } from '@pluxel/runtime-static'
import {
	createHostConfigRecords,
	createHostRuntimeState,
	product,
	staticHostPlugins,
} from './showcase/catalog'

export { product }
export { staticHostPlugins as staticDemoPlugins }

export default defineStaticRuntime({
	name: 'pluxel-architecture-lab-static',
	plugins: staticHostPlugins,
	configure({ env, deployment }) {
		const staticDataRoot = env.PLUXEL_STATIC_DATA_ROOT
			? resolve(env.PLUXEL_STATIC_DATA_ROOT)
			: resolve(deployment?.root ?? resolve(import.meta.dirname, '..'), '.pluxel/static')
		return {
			configService: {
				mode: 'memory',
				snapshot: { plugins: createHostConfigRecords() },
			},
			runtimeState: {
				mode: 'memory',
				snapshot: createHostRuntimeState(false),
			},
			workbench: env.PLUXEL_WORKBENCH === 'false' ? false : { enabled: true },
			persistence: resolve(staticDataRoot, 'persistence'),
			vault: {},
		}
	},
})

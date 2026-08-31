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
	configure() {
		return {
			configService: {
				mode: 'memory',
				snapshot: { plugins: createHostConfigRecords() },
			},
			runtimeState: {
				mode: 'memory',
				snapshot: createHostRuntimeState(false),
			},
			workbench: { enabled: true },
			persistence: '.pluxel/static/persistence',
			vault: {},
		}
	},
})

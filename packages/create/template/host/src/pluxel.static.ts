import { resolve } from 'node:path'
import { defineStaticRuntime } from '@pluxel/runtime-static'
import { product } from './product'
import { exampleConfigService, examplePlugins, exampleRuntimeState } from './runtime-state'

export { product }

export default defineStaticRuntime({
	name: 'pluxel-example',
	plugins: examplePlugins,
	configure({ env, deployment }) {
		const dataRoot = resolve(
			env.PLUXEL_DATA_ROOT ?? deployment?.root ?? resolve(import.meta.dirname, '..'),
			'.pluxel/static',
		)
		return {
			configService: exampleConfigService(),
			runtimeState: exampleRuntimeState(),
			persistence: resolve(dataRoot, 'persistence'),
			workbench:
				env.PLUXEL_WORKBENCH === 'true'
					? {
							enabled: true,
							access: { exposure: 'private' },
							uiBasePath: '/__pluxel/workbench',
						}
					: false,
		}
	},
})

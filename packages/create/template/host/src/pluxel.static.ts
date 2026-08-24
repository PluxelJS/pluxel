import { resolve } from 'node:path'
import { TodoConfig, TodoPlugin } from '@example/todo-plugin'
import { bindConfigEnvironment, defineStaticRuntime } from '@pluxel/runtime-static'
import { product } from './product'
import { exampleConfigService, examplePlugins, exampleRuntimeState } from './runtime-state'

export { product }

export default defineStaticRuntime({
	name: 'pluxel-example',
	plugins: examplePlugins,
	configEnvironmentBootstrap: [
		bindConfigEnvironment(TodoPlugin, TodoConfig, {
			maxItems: 'EXAMPLE_TODO_MAX_ITEMS',
		}),
	],
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
							uiBasePath: '/__pluxel/workbench',
						}
					: false,
		}
	},
})

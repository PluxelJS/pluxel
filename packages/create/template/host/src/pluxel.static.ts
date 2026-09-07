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
	configure() {
		return {
			configService: exampleConfigService(),
			runtimeState: exampleRuntimeState(),
			persistence: '.pluxel/persistence',
			workbench: { enabled: true, uiBasePath: '/__pluxel/workbench' },
		}
	},
})

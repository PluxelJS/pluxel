import { TodoConfig, TodoPlugin } from '@example/todo-plugin'
import { bindConfigEnvironment, type RuntimeApplication } from '@pluxel/runtime'
import { dynamicSource } from '@pluxel/host-dynamic'
import { resolveHostEnv } from '@pluxel/runtime/environment'
import { resolve } from 'node:path'
import { product } from './product'
import { exampleConfigService, examplePlugins, exampleRuntimeState } from './runtime-state'

export { product }

const dataRoot = resolve(process.cwd(), resolveHostEnv().dataRoot)

export default {
	name: 'pluxel-example',
	plugins: examplePlugins,
	sources: [
		dynamicSource({
			kind: 'directory',
			path: resolve(dataRoot, 'managed-plugins'),
			include: ['*.mjs'],
		}),
	],
	configEnvironmentBootstrap: [
		bindConfigEnvironment(TodoPlugin, TodoConfig, {
			maxItems: 'EXAMPLE_TODO_MAX_ITEMS',
		}),
	],
	configure() {
		return {
			configService: exampleConfigService(),
			runtimeState: exampleRuntimeState(),
			persistence: resolve(dataRoot, 'persistence'),
			workbench: { enabled: true, uiBasePath: '/__pluxel/workbench' },
		}
	},
} satisfies RuntimeApplication

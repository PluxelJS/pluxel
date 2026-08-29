import { pluginNodeAddressOf } from '@pluxel/runtime'
import { AuditPlugin } from '@example/audit-plugin'
import { HttpPlugin } from '@example/http-plugin'
import { TodoPlugin } from '@example/todo-plugin'

export const examplePlugins = [AuditPlugin, TodoPlugin, HttpPlugin] as const
const exampleAutoStartPlugins = [AuditPlugin, HttpPlugin] as const

export function exampleRuntimeState() {
	return {
		mode: 'memory' as const,
		snapshot: { autoStart: exampleAutoStartPlugins.map(pluginNodeAddressOf) },
	}
}

export function exampleConfigService() {
	return {
		mode: 'memory' as const,
		snapshot: {
			plugins: [
				{
					owner: pluginNodeAddressOf(TodoPlugin),
					config: { maxItems: 12, seedTitle: 'Trace a Todo from React to a Plugin' },
				},
			],
		},
	}
}

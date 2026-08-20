import { pluginNodeAddressOf } from '@pluxel/runtime'
import { AuditPlugin } from '@example/audit-plugin'
import { HttpPlugin } from '@example/http-plugin'
import { TodoPlugin } from '@example/todo-plugin'

export const examplePlugins = [AuditPlugin, TodoPlugin, HttpPlugin] as const

export function exampleRuntimeState() {
	return {
		mode: 'memory' as const,
		snapshot: { enabled: examplePlugins.map(pluginNodeAddressOf) },
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

import { VaultAdminPlugin } from '@pluxel/services/plugins'
import { AuditPlugin } from '@example/audit-plugin'
import { HttpPlugin } from '@example/http-plugin'
import { TodoPlugin } from '@example/todo-plugin'

export const examplePlugins = [AuditPlugin, TodoPlugin, HttpPlugin, VaultAdminPlugin] as const
const exampleAutoStartPlugins = [AuditPlugin, HttpPlugin, VaultAdminPlugin] as const

export function exampleHostPolicy() {
	return {
		autoStart: exampleAutoStartPlugins,
		mode: { autoStart: 'saved-first' as const },
	}
}

export function exampleHostConfig(rawMaxItems?: string) {
	return {
		mode: 'saved-first' as const,
		records: [
			{
				owner: TodoPlugin.nodeAddress(),
				config: {
					maxItems: rawMaxItems === undefined ? 12 : Number(rawMaxItems),
					seedTitle: 'Trace a Todo from React to a Plugin',
				},
			},
		],
	}
}

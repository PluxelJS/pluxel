import { VaultAdminPlugin } from '@pluxel/vault-admin'
import { pluginNodeAddressOf } from '@pluxel/core'
import { AuditPlugin } from '@example/audit-plugin'
import { HttpPlugin } from '@example/http-plugin'
import { TodoPlugin } from '@example/todo-plugin'

export const examplePlugins = [AuditPlugin, TodoPlugin, HttpPlugin, VaultAdminPlugin] as const
const exampleAutoStartPlugins = [AuditPlugin, HttpPlugin, VaultAdminPlugin] as const

export function exampleHostState() {
	return {
		mode: 'memory' as const,
		initial: { autoStart: exampleAutoStartPlugins.map(pluginNodeAddressOf) },
	}
}

export function exampleConfigRecords(rawMaxItems?: string) {
	return {
		mode: 'memory' as const,
		initial: [
			{
				owner: pluginNodeAddressOf(TodoPlugin),
				config: {
					maxItems: rawMaxItems === undefined ? 12 : Number(rawMaxItems),
					seedTitle: 'Trace a Todo from React to a Plugin',
				},
			},
		],
	}
}

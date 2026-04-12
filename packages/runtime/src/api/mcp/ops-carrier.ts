import type { Context } from '@pluxel/core'
import type { McpServer } from 'mcp-lite'
import { ensureRuntimeOpsRegistered } from '../ops'
import { textResult } from './shared'

function summarizeOpResult(toolName: string, result: unknown): string {
	if (result && typeof result === 'object') {
		const ok = (result as { ok?: unknown }).ok
		if (typeof ok === 'boolean') return `${toolName}: ${ok ? 'ok' : 'failed'}`
		const results = (result as { results?: unknown }).results
		if (Array.isArray(results)) return `${toolName}: ${results.length} result(s)`
		const items = (result as { items?: unknown }).items
		if (Array.isArray(items)) return `${toolName}: ${items.length} item(s)`
	}
	return `${toolName}: ok`
}

export function registerRuntimeOpsCarrier(server: McpServer, ctx: Context) {
	const root = (ctx.root ?? ctx) as Context
	ensureRuntimeOpsRegistered(root)

	for (const tool of root.ops.listTools()) {
		server.tool(tool.name, {
			description: tool.guidance,
			inputSchema: tool.inputSchema as any,
			...(tool.outputSchema ? { outputSchema: tool.outputSchema as any } : {}),
			handler: async (args) => {
				const result = await root.ops.invoke(tool.id, args, {
					source: { kind: 'mcp' },
				})
				return textResult(summarizeOpResult(tool.name, result), result)
			},
		})
	}
}

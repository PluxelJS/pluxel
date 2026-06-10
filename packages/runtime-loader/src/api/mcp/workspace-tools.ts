import type { Context } from '@pluxel/core'
import type { McpServer, ToolCallResult } from 'mcp-lite'
import * as v from 'valibot'
import { workspaceListEntries, workspaceResolveEntry } from '../usecases/workspace'

const EntryResolutionOkSchema = v.object({
	ok: v.literal(true),
	dir: v.string(),
	entry: v.string(),
	source: v.string(),
	tried: v.array(v.string()),
})

const EntryResolutionErrSchema = v.object({
	ok: v.literal(false),
	dir: v.string(),
	code: v.string(),
	message: v.string(),
	tried: v.optional(v.array(v.string())),
})

const EntryResolutionSchema = v.union([EntryResolutionOkSchema, EntryResolutionErrSchema])

const WorkspaceResolveEntryInputSchema = v.object({
	name: v.string(),
	workspaceOnly: v.optional(v.boolean()),
	preferRuntimeLoaderExports: v.optional(v.boolean()),
	conditions: v.optional(v.array(v.string())),
})

const WorkspaceListEntriesOutputSchema = v.array(v.object({ dir: v.string(), entry: v.string() }))

function textResult<T>(text: string, structuredContent: T): ToolCallResult<T> {
	return {
		content: [{ type: 'text' as const, text }],
		structuredContent,
	}
}

export function registerWorkspaceMcpTools(server: McpServer, ctx: Context) {
	server.tool('workspace.resolveEntry', {
		description: 'Resolve a workspace package entry (prefer @pluxel/runtime-loader export by default).',
		inputSchema: WorkspaceResolveEntryInputSchema,
		outputSchema: EntryResolutionSchema,
		handler: async (args) => {
			const out = await workspaceResolveEntry(ctx, args)
			const msg = out.ok === true ? out.entry : out.message
			return textResult(msg, out)
		},
	})

	server.tool('workspace.listEntries', {
		description: 'List workspace packages that have a resolvable entry.',
		inputSchema: v.object({}),
		outputSchema: WorkspaceListEntriesOutputSchema,
		handler: async () => {
			const out = await workspaceListEntries(ctx)
			return textResult(`entries: ${out.length}`, out)
		},
	})
}

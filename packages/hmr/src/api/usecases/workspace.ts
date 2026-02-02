import type { Context } from '@pluxel/core'

const DEFAULT_CONDITIONS = ['@pluxel/hmr', 'import', 'module', 'default'] as const

export type WorkspaceResolveEntryInput = {
	name: string
	workspaceOnly?: boolean
	preferHmrExports?: boolean
	conditions?: string[]
}

export async function workspaceResolveEntry(ctx: Context, input: WorkspaceResolveEntryInput) {
	const name = String(input.name ?? '').trim()
	if (!name) {
		return { ok: false as const, code: 'MISSING_PACKAGE', message: 'name is required' }
	}

	const preferHmrExports = input.preferHmrExports !== false
	const conditions = Array.isArray(input.conditions) && input.conditions.length
		? input.conditions
		: [...DEFAULT_CONDITIONS]

	return await ctx.scanService.resolveEntry(
		{ name },
		{
			workspaceOnly: input.workspaceOnly === true,
			scan: { conditions, ...(preferHmrExports ? { preferHmrExports: true } : {}) },
		},
	)
}

export async function workspaceListEntries(ctx: Context) {
	return await ctx.scanService.listWorkspaceEntries({
		scan: { conditions: [...DEFAULT_CONDITIONS], preferHmrExports: true },
	})
}


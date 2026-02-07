import type { Context } from '@pluxel/core'
import { PLUXEL_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE } from '../../services/runtime/shared/conditions'

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
		: [...PLUXEL_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE]

	return await ctx.scanService.resolveEntryByName(name, {
		workspaceOnly: input.workspaceOnly === true,
		scan: { conditions, ...(preferHmrExports ? { preferHmrExports: true } : {}) },
	})
}

export async function workspaceListEntries(ctx: Context) {
	return await ctx.scanService.listWorkspaceEntries({
		scan: { conditions: [...PLUXEL_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE], preferHmrExports: true },
	})
}

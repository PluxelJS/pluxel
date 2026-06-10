import type { Context } from '@pluxel/core'
import { PLUXEL_LOADER_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE } from '@pluxel/runtime/shared'

export type WorkspaceResolveEntryInput = {
	name: string
	workspaceOnly?: boolean
	preferRuntimeDynamicExports?: boolean
	conditions?: string[]
}

type ScanServiceLike = {
	resolveEntryByName(
		name: string,
		options: unknown,
	): Promise<
		| { ok: true; dir: string; entry: string; source: string; tried: string[] }
		| { ok: false; dir: string; code: string; message: string; tried?: string[] }
	>
	listWorkspaceEntries(options: unknown): Promise<Array<{ dir: string; entry: string }>>
}

function getScanService(ctx: Context): ScanServiceLike {
	const scanService = (ctx as unknown as { scanService?: ScanServiceLike }).scanService
	if (!scanService) {
		throw new Error(
			'[pluxel/runtime-dynamic] workspace APIs require ScanService registration.',
		)
	}
	return scanService
}

export async function workspaceResolveEntry(ctx: Context, input: WorkspaceResolveEntryInput) {
	const name = String(input.name ?? '').trim()
	if (!name) {
		return { ok: false as const, code: 'MISSING_PACKAGE', message: 'name is required' }
	}

	const preferRuntimeDynamicExports = input.preferRuntimeDynamicExports !== false
	const conditions =
		Array.isArray(input.conditions) && input.conditions.length > 0
			? input.conditions
			: [...PLUXEL_LOADER_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE]

	return await getScanService(ctx).resolveEntryByName(name, {
		workspaceOnly: input.workspaceOnly === true,
		scan: { conditions, ...(preferRuntimeDynamicExports ? { preferRuntimeDynamicExports: true } : {}) },
	})
}

export async function workspaceListEntries(ctx: Context) {
	return await getScanService(ctx).listWorkspaceEntries({
		scan: { conditions: [...PLUXEL_LOADER_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE], preferRuntimeDynamicExports: true },
	})
}

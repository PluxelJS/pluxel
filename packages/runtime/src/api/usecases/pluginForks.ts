import { getPluginInfo, type PluginConstructor, type Context } from '@pluxel/core'

import { addForkToCatalog } from './forksCatalog'

export type EnsureForkResult =
	| { ok: true; forkName: string }
	| { ok: false; code: string; error: string }

function resolvePluginCtor(ctx: Context, name: string): PluginConstructor {
	const ctor = ctx.loader.api.runtime.resolve(name) ?? ctx.loader.api.registry.getCtor(name)
	if (!ctor) throw new Error(`Plugin not found: ${name}`)
	return ctor
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	if (error && typeof error === 'object') {
		const message = (error as { message?: unknown }).message
		if (typeof message === 'string') return message
	}
	return String(error)
}

export async function ensureFork(
	ctx: Context,
	baseName: string,
	forkId: string,
	options?: { enable?: boolean },
): Promise<EnsureForkResult> {
	try {
		const base = typeof baseName === 'string' ? baseName.trim() : ''
		const fid = typeof forkId === 'string' ? forkId.trim() : ''
		if (!base || !fid) return { ok: false, code: 'invalid_fork', error: 'baseName/forkId required' }

		const baseCtor = resolvePluginCtor(ctx, base)
		const forkCtor = ctx.registry.fork(baseCtor as any, fid) as PluginConstructor
		const forkName = getPluginInfo(forkCtor as any).id

		addForkToCatalog(ctx, base, fid)
		if (options?.enable !== false) {
			await ctx.loader.api.control.enable(forkName, forkCtor)
		}

		const commit = await ctx.registry.commit()
		if ((commit as any)?.err)
			return { ok: false, code: 'commit_failed', error: String((commit as any).err) }
		return { ok: true, forkName }
	} catch (error) {
		return { ok: false, code: 'ensure_fork_failed', error: getErrorMessage(error) }
	}
}

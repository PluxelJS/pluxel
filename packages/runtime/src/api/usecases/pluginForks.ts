import {
	pluginNodeAddressOf,
	type Context,
	type PluginConstructor,
	type PluginNodeAddress,
} from '@pluxel/core'
import { addForkToCatalog } from './forksCatalog'
import { requireRouteCapability } from '../../runtime/capabilities'

export type EnsureForkResult =
	| { ok: true; fork: PluginNodeAddress }
	| { ok: false; code: string; error: string }

export async function ensureFork(
	ctx: Context,
	base: PluginNodeAddress,
	forkId: string,
	options?: { enable?: boolean },
): Promise<EnsureForkResult> {
	try {
		if (base.variant !== 'default')
			return { ok: false, code: 'invalid_base', error: 'Fork base must be a default Plugin node' }
		const id = String(forkId).trim()
		if (!id) return { ok: false, code: 'invalid_fork', error: 'forkId is required' }
		const baseCtor = requireRouteCapability(ctx, 'catalog').resolve(base)
		if (!baseCtor)
			return {
				ok: false,
				code: 'base_not_found',
				error: 'Fork base is not present in the route catalog',
			}
		const forkCtor = ctx.registry.fork(baseCtor as never, id) as PluginConstructor
		const fork = pluginNodeAddressOf(forkCtor)
		addForkToCatalog(ctx, base.definition, id)
		if (options?.enable !== false)
			await requireRouteCapability(ctx, 'lifecycle').enable(fork, forkCtor)
		const commit = await ctx.registry.commit()
		return commit.err
			? { ok: false, code: 'commit_failed', error: String(commit.err) }
			: { ok: true, fork }
	} catch (error) {
		return {
			ok: false,
			code: 'ensure_fork_failed',
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

import { ForkablePlugin, parseForkPluginId, type Context } from '@pluxel/core'

import { requireRouteCapability } from '../../runtime/capabilities'

export function addForkToCatalog(ctx: Context, originalName: string, forkId: string) {
	ctx.runtimeState.update((draft) => {
		const prev = Array.isArray(draft.forks[originalName]) ? draft.forks[originalName] : []
		if (prev.includes(forkId)) return
		draft.forks[originalName] = [...prev, forkId]
	})
}

export function maybeAddForkToCatalog(ctx: Context, name: string) {
	const fork = parseForkPluginId(name)
	if (!fork) return
	try {
		const baseCtor = requireRouteCapability(ctx, 'catalog').resolve(fork.baseId)
		if (!baseCtor) return
		const proto = (baseCtor as { prototype?: unknown }).prototype
		if (!proto || !(proto instanceof ForkablePlugin)) return
		addForkToCatalog(ctx, fork.baseId, fork.forkId)
	} catch {
		// ignore
	}
}

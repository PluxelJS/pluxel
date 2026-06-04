import { ForkablePlugin, parseForkPluginId, type Context } from '@pluxel/core'

import {
	EXTRA_FORKS,
	type ForksExtra,
	getRuntimePluginCatalog,
} from '../../services/runtime/catalog/RuntimePluginCatalogService'

function getExtraApi(ctx: Context): {
	getExtra?: (key: string) => unknown
	setExtra?: (key: string, value: unknown) => void
} {
	const svc = ctx.configService as unknown
	if (!svc || typeof svc !== 'object') return {}
	const getExtra = (svc as { getExtra?: unknown }).getExtra
	const setExtra = (svc as { setExtra?: unknown }).setExtra
	return {
		getExtra: typeof getExtra === 'function' ? getExtra.bind(svc) : undefined,
		setExtra: typeof setExtra === 'function' ? setExtra.bind(svc) : undefined,
	}
}

export function addForkToCatalog(ctx: Context, originalName: string, forkId: string) {
	const { getExtra, setExtra } = getExtraApi(ctx)
	if (typeof getExtra !== 'function' || typeof setExtra !== 'function') return

	const all = (getExtra(EXTRA_FORKS) as ForksExtra | undefined) ?? {}
	const prev = Array.isArray(all[originalName]) ? all[originalName] : []
	if (prev.includes(forkId)) return
	setExtra(EXTRA_FORKS, { ...all, [originalName]: [...prev, forkId] })
}

export function maybeAddForkToCatalog(ctx: Context, name: string) {
	const fork = parseForkPluginId(name)
	if (!fork) return
	try {
		const baseCtor = getRuntimePluginCatalog(ctx).resolve(fork.baseId)
		if (!baseCtor) return
		const proto = (baseCtor as { prototype?: unknown }).prototype
		if (!proto || !(proto instanceof ForkablePlugin)) return
		addForkToCatalog(ctx, fork.baseId, fork.forkId)
	} catch {
		// ignore
	}
}

import type { PluginDefinitionAddress, RootContext } from '@pluxel/core'
import type { PluginRpcSite } from '@pluxel/core/internal'
import type { PluginCatalogSnapshot } from './catalog'

/** Internal bridge installed only by an explicit RPC Host service. */
export type HostRpcCatalogRegistrar = Readonly<{
	prepare(entries: readonly HostRpcCatalogEntry[]): () => void
}>

export type HostRpcCatalogEntry = Readonly<{
	definition: PluginDefinitionAddress
	sites: readonly PluginRpcSite[]
}>

const registrars = new WeakMap<RootContext, HostRpcCatalogRegistrar>()

export function installHostRpcCatalogRegistrar(
	ctx: RootContext,
	registrar: HostRpcCatalogRegistrar,
): void {
	if (registrars.has(ctx)) throw new Error('[host:rpc] registrar is already installed')
	registrars.set(ctx, registrar)
	ctx.effects.defer(
		() => {
			registrars.delete(ctx)
		},
		{ tag: 'HostRpcCatalogRegistrar', phase: 'shutdown' },
	)
}

/** Prepare before graph admission; publish only at Core's graph confirmation point. */
export function prepareHostRpcCatalog(
	ctx: RootContext,
	catalog: PluginCatalogSnapshot,
): () => void {
	const registrar = registrars.get(ctx)
	if (!registrar) return () => undefined
	return registrar.prepare(
		catalog.entries.flatMap((entry) =>
			entry.candidate.rpcSites
				? [{ definition: entry.address, sites: entry.candidate.rpcSites }]
				: [],
		),
	)
}

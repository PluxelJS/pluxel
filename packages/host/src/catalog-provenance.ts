import type { PluginConstructor, RootContext } from '@pluxel/core'
import type { PluginCatalogProvenance } from './catalog'
import { clonePluginExecutionSnapshot } from './execution'

const bindings = new WeakMap<RootContext, ReadonlyMap<PluginConstructor, PluginCatalogProvenance>>()

/** Route input only. Published facts live exclusively in the committed catalog snapshot. */
export function setHostCatalogProvenance(
	ctx: RootContext,
	provenance: ReadonlyMap<PluginConstructor, PluginCatalogProvenance>,
): void {
	const snapshot = new Map(
		[...provenance].map(
			([plugin, value]) =>
				[
					plugin,
					Object.freeze({
						...value,
						...(value.execution
							? { execution: clonePluginExecutionSnapshot(value.execution) }
							: {}),
					}),
				] as const,
		),
	)
	if (!bindings.has(ctx))
		ctx.effects.defer(
			() => {
				bindings.delete(ctx)
			},
			{ tag: 'HostCatalogProvenance', phase: 'shutdown' },
		)
	bindings.set(ctx, snapshot)
}

export function readHostCatalogProvenance(
	ctx: RootContext,
	plugin: PluginConstructor,
): PluginCatalogProvenance | undefined {
	return bindings.get(ctx)?.get(plugin)
}

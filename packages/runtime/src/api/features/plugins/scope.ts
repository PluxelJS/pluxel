import {
	parsePluginNodeAddress,
	type PluginConstructor,
	type Context as PlxContext,
	type PluginNodeAddress,
} from '@pluxel/core'
import { GraphQLError } from 'graphql'
import type { PluginOutput } from './schema'
import { requireRouteCapability } from '../../../runtime/capabilities'
import {
	projectedPluginByAddress,
	projectPluginCatalog,
	type PluginCatalogProjectionEntry,
} from './catalog-projection'

const PLUGIN_CTOR = Symbol('pluginCtor')
type InternalPlugin = PluginOutput & { [PLUGIN_CTOR]?: PluginConstructor }

export function ensurePlugin(pCtx: PlxContext, address: PluginNodeAddress): PluginConstructor {
	const ctor = requireRouteCapability(pCtx, 'catalog').resolve(address)
	if (ctor) return ctor
	throw new GraphQLError('Plugin not found', { extensions: { code: 'NOT_FOUND', address } })
}

export function createPlugin(pCtx: PlxContext, route: string): PluginOutput {
	const entry = projectPluginCatalog(pCtx).byRoute.get(route)
	if (!entry) {
		throw new GraphQLError('Plugin not found', {
			extensions: { code: 'NOT_FOUND', route },
		})
	}
	return pluginOutput(pCtx, entry)
}

export function getPluginCtor(pCtx: PlxContext, plugin: PluginOutput): PluginConstructor {
	return (
		(plugin as InternalPlugin)[PLUGIN_CTOR] ??
		ensurePlugin(pCtx, parsePluginNodeAddress(plugin.address))
	)
}

export function listPlugins(pCtx: PlxContext): PluginOutput[] {
	return projectPluginCatalog(pCtx).entries.map((entry) => pluginOutput(pCtx, entry))
}

export function getPluginDependencies(pCtx: PlxContext, owner: PluginNodeAddress): PluginOutput[] {
	const projection = projectPluginCatalog(pCtx)
	return requireRouteCapability(pCtx, 'dependencies')
		.listDependencies(owner)
		.map((dependency) => {
			const entry = projectedPluginByAddress(projection, dependency.address)
			if (!entry) {
				throw new GraphQLError('Plugin dependency is not present in the route catalog', {
					extensions: { code: 'NOT_FOUND', address: dependency.address },
				})
			}
			return pluginOutput(pCtx, entry)
		})
}

function pluginOutput(pCtx: PlxContext, entry: PluginCatalogProjectionEntry): PluginOutput {
	return {
		__typename: 'Plugin',
		id: entry.route,
		reference: entry.reference,
		route: entry.route,
		displayName: entry.displayName,
		label: entry.label.text,
		rootExportName: entry.rootExportName,
		address: entry.address,
		[PLUGIN_CTOR]: ensurePlugin(pCtx, entry.address),
	} as InternalPlugin
}

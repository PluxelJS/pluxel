import type { PluginConstructor, Context as PlxContext } from '@pluxel/core'
import { GraphQLError } from 'graphql'

import type { PluginOutput } from './schema'
import { runtimePluginCatalog } from './catalog'

const PLUGIN_CTOR = Symbol('pluginCtor')

type InternalPlugin = PluginOutput & { [PLUGIN_CTOR]?: PluginConstructor }

export function ensurePlugin(pCtx: PlxContext, name: string): PluginConstructor {
	try {
		return runtimePluginCatalog(pCtx).require(name)
	} catch {
		throw new GraphQLError('Plugin not found', {
			extensions: { code: 'NOT_FOUND', name },
		})
	}
}

export function createPlugin(pCtx: PlxContext, name: string): PluginOutput {
	const plugin = {
		__typename: 'Plugin' as const,
		id: name,
		name,
		[PLUGIN_CTOR]: ensurePlugin(pCtx, name),
	} as InternalPlugin
	return plugin
}

export function getPluginCtor(pCtx: PlxContext, plugin: PluginOutput): PluginConstructor {
	const internal = plugin as InternalPlugin
	if (internal[PLUGIN_CTOR])
		return runtimePluginCatalog(pCtx).resolve(internal[PLUGIN_CTOR]) ?? internal[PLUGIN_CTOR]!
	return ensurePlugin(pCtx, plugin.name)
}

export function listPlugins(pCtx: PlxContext): PluginOutput[] {
	return runtimePluginCatalog(pCtx)
		.statusOverview()
		.statuses.map((snap) => ({
			__typename: 'Plugin' as const,
			id: snap.name,
			name: snap.name,
		}))
}

export function getPluginDependencies(pCtx: PlxContext, ctor: PluginConstructor): PluginOutput[] {
	return runtimePluginCatalog(pCtx)
		.listDependencies(ctor)
		.map((dep) => ({
			__typename: 'Plugin' as const,
			id: dep.name,
			name: dep.name,
		}))
}

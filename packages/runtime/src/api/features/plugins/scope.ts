import {
	parsePluginNodeAddress,
	type PluginConstructor,
	type Context as PlxContext,
	type PluginNodeAddressSnapshot,
} from '@pluxel/core'
import { GraphQLError } from 'graphql'
import type { PluginOutput } from './schema'
import { requireRouteCapability, runtimePluginStatusOverview } from '../../../runtime/capabilities'
import { pluginNodeAddressKey } from '../../../runtime/plugin-address'

const PLUGIN_CTOR = Symbol('pluginCtor')
type InternalPlugin = PluginOutput & { [PLUGIN_CTOR]?: PluginConstructor }

function entryById(pCtx: PlxContext, id: string) {
	return requireRouteCapability(pCtx, 'catalog')
		.listRegistered()
		.find((entry) => pluginNodeAddressKey(entry.address) === id)
}

export function ensurePlugin(
	pCtx: PlxContext,
	address: PluginNodeAddressSnapshot,
): PluginConstructor {
	const ctor = requireRouteCapability(pCtx, 'catalog').resolve(address)
	if (ctor) return ctor
	throw new GraphQLError('Plugin not found', { extensions: { code: 'NOT_FOUND', address } })
}

export function createPlugin(pCtx: PlxContext, id: string): PluginOutput {
	const entry = entryById(pCtx, id)
	if (!entry) throw new GraphQLError('Plugin not found', { extensions: { code: 'NOT_FOUND', id } })
	return {
		__typename: 'Plugin',
		id,
		name: entry.displayName,
		rootExportName: entry.rootExportName,
		address: entry.address,
		[PLUGIN_CTOR]: entry.ctor,
	} as InternalPlugin
}

export function getPluginCtor(pCtx: PlxContext, plugin: PluginOutput): PluginConstructor {
	return (
		(plugin as InternalPlugin)[PLUGIN_CTOR] ??
		ensurePlugin(pCtx, parsePluginNodeAddress(plugin.address))
	)
}

export function listPlugins(pCtx: PlxContext): PluginOutput[] {
	return runtimePluginStatusOverview(pCtx).statuses.map((entry) => ({
		__typename: 'Plugin',
		id: pluginNodeAddressKey(entry.address),
		name: entry.displayName,
		rootExportName: entry.rootExportName,
		address: entry.address,
	}))
}

export function getPluginDependencies(
	pCtx: PlxContext,
	owner: PluginNodeAddressSnapshot,
): PluginOutput[] {
	return requireRouteCapability(pCtx, 'dependencies')
		.listDependencies(owner)
		.map((dependency) => ({
			__typename: 'Plugin',
			id: pluginNodeAddressKey(dependency.address),
			name: dependency.displayName,
			rootExportName: dependency.address.definition.exportName,
			address: dependency.address,
		}))
}

import { type Context as PlxContext, type PluginNodeAddress } from '@pluxel/core'
import { GraphQLError } from 'graphql'
import type { PluginOutput } from './schema'
import { listPluginDependencies } from '../../usecases/pluginDependencies'
import {
	projectedPluginByAddress,
	projectPluginCatalog,
	type PluginCatalogProjectionEntry,
} from './catalog-projection'

export function createPlugin(pCtx: PlxContext, route: string): PluginOutput {
	const entry = projectPluginCatalog(pCtx).byRoute.get(route)
	if (!entry) {
		throw new GraphQLError('Plugin not found', {
			extensions: { code: 'NOT_FOUND', route },
		})
	}
	return pluginOutput(entry)
}

export function listPlugins(pCtx: PlxContext): PluginOutput[] {
	return projectPluginCatalog(pCtx).entries.map(pluginOutput)
}

export function getPluginDependencies(pCtx: PlxContext, owner: PluginNodeAddress): PluginOutput[] {
	const projection = projectPluginCatalog(pCtx)
	return listPluginDependencies(pCtx, owner).map((dependency) => {
		const entry = projectedPluginByAddress(projection, dependency.address)
		if (!entry) {
			throw new GraphQLError('Plugin dependency is not present in the route catalog', {
				extensions: { code: 'NOT_FOUND', address: dependency.address },
			})
		}
		return pluginOutput(entry)
	})
}

function pluginOutput(entry: PluginCatalogProjectionEntry): PluginOutput {
	return {
		__typename: 'Plugin',
		id: entry.route,
		reference: entry.reference,
		route: entry.route,
		displayName: entry.displayName,
		label: entry.label.text,
		rootExportName: entry.rootExportName,
		address: entry.address,
	}
}

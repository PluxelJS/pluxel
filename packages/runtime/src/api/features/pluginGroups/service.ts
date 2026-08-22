import { parsePluginNodeAddress, type Context as PlxContext } from '@pluxel/core'
import { GraphQLError } from 'graphql'

import { requireWorkbench } from '../../../services/workbench'
import {
	projectedPluginByAddress,
	projectPluginCatalog,
	type PluginCatalogProjection,
} from '../plugins/catalog-projection'
import type { PluginGroupInputValue, PluginGroupOutput } from './schema'

export async function readGroups(pCtx: PlxContext): Promise<PluginGroupOutput[]> {
	const groups = await requireWorkbench(pCtx).pluginCatalog.listGroups()
	const projection = projectPluginCatalog(pCtx)
	return groups.map((group) => toOutput(group, projection))
}

export async function readGroup(pCtx: PlxContext, id: string): Promise<PluginGroupOutput> {
	const group = await requireWorkbench(pCtx).pluginCatalog.getGroup(id)
	if (!group) {
		throw new GraphQLError('Plugin group not found', {
			extensions: { code: 'NOT_FOUND', id },
		})
	}
	return toOutput(group, projectPluginCatalog(pCtx))
}

export async function writeGroups(
	pCtx: PlxContext,
	groups: PluginGroupInputValue[],
): Promise<PluginGroupOutput[]> {
	try {
		const result = await requireWorkbench(pCtx).pluginCatalog.updateGroups(
			groups.map((group) => ({
				...group,
				nodes: group.nodes.map((owner) => parsePluginNodeAddress(owner)),
			})),
		)
		const projection = projectPluginCatalog(pCtx)
		return result.map((group) => toOutput(group, projection))
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error) {
			throw new GraphQLError(error instanceof Error ? error.message : 'Invalid plugin groups', {
				extensions: { code: String(error.code) },
			})
		}
		throw error
	}
}

function toOutput(
	group: {
		groupId: string
		name: string
		nodes: readonly import('@pluxel/core').PluginNodeAddress[]
	},
	projection: PluginCatalogProjection,
): PluginGroupOutput {
	return {
		__typename: 'PluginGroup' as const,
		id: group.groupId,
		groupId: group.groupId,
		name: group.name,
		nodes: group.nodes.map((owner) => {
			const node = projectedPluginByAddress(projection, owner)
			if (!node) throw new GraphQLError('Plugin group node not found')
			return groupNodeOutput(node)
		}),
	}
}

export function readGroupNode(pCtx: PlxContext, id: string): PluginGroupOutput['nodes'][number] {
	const status = projectPluginCatalog(pCtx).byRoute.get(id)
	if (!status) throw new GraphQLError('Plugin group node not found')
	return groupNodeOutput(status)
}

function groupNodeOutput(
	status: PluginCatalogProjection['entries'][number],
): PluginGroupOutput['nodes'][number] {
	return {
		__typename: 'PluginGroupNode' as const,
		id: status.route,
		reference: status.reference,
		route: status.route,
		displayName: status.displayName,
		label: status.label.text,
		rootExportName: status.rootExportName,
		address: status.address,
	}
}

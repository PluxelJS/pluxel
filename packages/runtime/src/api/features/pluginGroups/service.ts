import { parsePluginNodeAddress, type Context as PlxContext } from '@pluxel/core'
import { GraphQLError } from 'graphql'

import { requireWorkbench } from '../../../services/workbench'
import { pluginNodeAddressKey } from '../../../runtime/plugin-address'
import { runtimePluginStatusOverview } from '../../../runtime/capabilities'
import type { PluginGroupInputValue, PluginGroupOutput } from './schema'

export async function readGroups(pCtx: PlxContext): Promise<PluginGroupOutput[]> {
	const groups = await requireWorkbench(pCtx).pluginCatalog.listGroups()
	return groups.map((group) => toOutput(pCtx, group))
}

export async function readGroup(pCtx: PlxContext, id: string): Promise<PluginGroupOutput> {
	const group = await requireWorkbench(pCtx).pluginCatalog.getGroup(id)
	if (!group) {
		throw new GraphQLError('Plugin group not found', {
			extensions: { code: 'NOT_FOUND', id },
		})
	}
	return toOutput(pCtx, group)
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
		return result.map((group) => toOutput(pCtx, group))
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
	pCtx: PlxContext,
	group: {
		groupId: string
		name: string
		nodes: readonly import('@pluxel/core').PluginNodeAddressSnapshot[]
	},
): PluginGroupOutput {
	return {
		__typename: 'PluginGroup' as const,
		id: group.groupId,
		groupId: group.groupId,
		name: group.name,
		nodes: group.nodes.map((owner) => readGroupNode(pCtx, pluginNodeAddressKey(owner))),
	}
}

export function readGroupNode(pCtx: PlxContext, id: string): PluginGroupOutput['nodes'][number] {
	const status = runtimePluginStatusOverview(pCtx).statuses.find(
		(candidate) => pluginNodeAddressKey(candidate.address) === id,
	)
	if (!status) throw new GraphQLError('Plugin group node not found')
	return {
		__typename: 'PluginGroupNode' as const,
		id,
		displayName: status.displayName,
		rootExportName: status.rootExportName,
		address: status.address,
	}
}

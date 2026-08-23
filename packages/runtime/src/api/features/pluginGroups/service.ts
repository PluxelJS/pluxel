import { parsePluginNodeAddress, type Context } from '@pluxel/core'
import type { PluginGroup, PluginGroupInput } from '../../../web/protocol'
import {
	projectedPluginByAddress,
	projectPluginCatalog,
	type PluginCatalogProjection,
} from '../plugins/catalog-projection'

export async function readGroups(ctx: Context): Promise<PluginGroup[]> {
	const groups = await requirePluginCatalogLayout(ctx).listGroups()
	const projection = projectPluginCatalog(ctx)
	return groups.map((group) => toOutput(group, projection))
}

export async function writeGroups(
	ctx: Context,
	groups: readonly PluginGroupInput[],
): Promise<PluginGroup[]> {
	const result = await requirePluginCatalogLayout(ctx).updateGroups(
		groups.map((group) => ({
			...group,
			nodes: group.nodes.map((owner) => parsePluginNodeAddress(owner)),
		})),
	)
	const projection = projectPluginCatalog(ctx)
	return result.map((group) => toOutput(group, projection))
}

function requirePluginCatalogLayout(ctx: Context) {
	const service = ctx.root.pluginCatalogLayout
	if (!service) {
		throw new Error('[pluxel/runtime] Plugin catalog groups require the management plane')
	}
	return service
}

function toOutput(
	group: {
		groupId: string
		name: string
		nodes: readonly import('@pluxel/core').PluginNodeAddress[]
	},
	projection: PluginCatalogProjection,
): PluginGroup {
	return {
		groupId: group.groupId,
		name: group.name,
		nodes: group.nodes.map((owner) => {
			const node = projectedPluginByAddress(projection, owner)
			if (!node) {
				throw new Error('[pluxel/runtime] Plugin catalog group references an unavailable node')
			}
			return {
				address: node.address,
				reference: node.reference,
				route: node.route,
				displayName: node.displayName,
				label: node.label.text,
				rootExportName: node.rootExportName,
			}
		}),
	}
}

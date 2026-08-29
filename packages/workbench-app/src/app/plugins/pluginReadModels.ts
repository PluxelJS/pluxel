import type { RuntimeManagementClient } from '../../runtime'
import {
	invalidatePluginDependencyGraph,
	refreshPluginDependencyGraph,
} from './pluginDependencyGraph'
import { invalidatePluginOverview, refreshPluginOverview } from './pluginOverview'

export function invalidatePluginReadModels(client: RuntimeManagementClient): void {
	invalidatePluginOverview(client)
	invalidatePluginDependencyGraph(client)
}

export async function refreshPluginReadModels(client: RuntimeManagementClient): Promise<void> {
	invalidatePluginReadModels(client)
	await Promise.all([refreshPluginOverview(client), refreshPluginDependencyGraph(client)])
}

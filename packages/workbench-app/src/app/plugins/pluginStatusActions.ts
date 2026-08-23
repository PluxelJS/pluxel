import {
	type PluginStatusBatchAction,
	type PluginStatusBatchResult,
	type PluginStatusAction,
	type PluginStatusMutationResult,
	type RuntimeManagementClient,
} from '../../runtime'
import type { PluginNodeAddress } from '@pluxel/core'

export type StatusActionResult = PluginStatusMutationResult

function normalizeBatchResults(payload: PluginStatusBatchResult): readonly StatusActionResult[] {
	return payload.results
}

export async function updatePluginStatuses(
	client: RuntimeManagementClient,
	actions: readonly PluginStatusBatchAction[],
): Promise<readonly StatusActionResult[]> {
	if (actions.length === 0) return []
	const result = await client.plugins.applyStatusActions(actions)
	const normalized = normalizeBatchResults(result)
	if (normalized.length === actions.length) return normalized
	throw new Error('运行时返回的插件状态结果数量与请求不一致')
}

export async function updatePluginStatus(
	client: RuntimeManagementClient,
	address: PluginNodeAddress,
	action: PluginStatusAction,
): Promise<PluginStatusMutationResult> {
	const result = await updatePluginStatuses(client, [{ address, action }])
	const first = result[0]
	if (!first) throw new Error('运行时未返回插件状态结果')
	return first
}

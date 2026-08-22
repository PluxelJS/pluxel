import {
	applyPluginStatusActions,
	invokeRpc,
	type PluginStatusBatchAction,
	type PluginStatusBatchResult,
	type PluginStatusMutationResult,
} from '../../runtime'

export type StatusActionResult = PluginStatusMutationResult

function normalizeBatchResults(payload: PluginStatusBatchResult): StatusActionResult[] {
	return payload.results
}

export async function updatePluginStatuses(
	actions: PluginStatusBatchAction[],
): Promise<StatusActionResult[]> {
	if (actions.length === 0) return []
	return await invokeRpc(async (rpc) => {
		const result = await applyPluginStatusActions(rpc, actions)
		const normalized = normalizeBatchResults(result)
		if (normalized.length === actions.length) return normalized
		throw new Error('运行时返回的插件状态结果数量与请求不一致')
	})
}

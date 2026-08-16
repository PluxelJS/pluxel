import {
	applyPluginStatusActions,
	invokeRpc,
	type PluginStatusBatchAction,
	type PluginStatusBatchResult,
	type PluginStatusMutationResult,
} from '../../runtime'

export type StatusActionResult = PluginStatusMutationResult & {
	commitError?: string
}

function normalizeBatchResults(payload: PluginStatusBatchResult): StatusActionResult[] {
	const commitError = payload.commitError
	return payload.results.map((item) => ({
		...item,
		ok: Boolean(item.ok) && !commitError,
		error: item.ok && commitError ? commitError : item.error,
		commitError,
	}))
}

export async function updatePluginStatuses(
	actions: PluginStatusBatchAction[],
): Promise<StatusActionResult[]> {
	if (actions.length === 0) return []
	try {
		return await invokeRpc(async (rpc) => {
			const result = await applyPluginStatusActions(rpc, actions)
			const normalized = normalizeBatchResults(result)
			if (normalized.length > 0) return normalized
			return actions.map(({ address }) => ({
				address,
				ok: false,
				error: result.commitError ?? '运行时未返回操作结果',
				commitError: result.commitError,
			}))
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : '请求失败'
		return actions.map(({ address }) => ({ address, ok: false, error: message }))
	}
}

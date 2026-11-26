import type { PluginNodeAddress } from '@pluxel/core'
import type { PluginControlBatchResult } from '@pluxel/services/management/client'

type FailedBatch = Extract<PluginControlBatchResult, { ok: false }>
type Operation = 'auto-start' | 'lifecycle'

const titles: Record<Operation, Record<FailedBatch['status'], string>> = {
	'auto-start': {
		unknown: '自动启动策略应用结果待核对',
		'applied-with-issues': '自动启动策略已应用，运行协调存在问题',
		'partially-applied': '自动启动策略部分应用',
		rejected: '自动启动策略更新被拒绝',
	},
	lifecycle: {
		unknown: '生命周期命令结果待核对',
		'applied-with-issues': '生命周期命令已应用，运行协调存在问题',
		'partially-applied': '生命周期命令部分执行',
		rejected: '生命周期命令被拒绝',
	},
}

/** Present the validated batch decision; retain its complete receipt for diagnosis. */
export function describePluginControlBatchFailure(
	operation: Operation,
	batch: FailedBatch,
	labelFor: (address: PluginNodeAddress) => string,
) {
	const message =
		'code' in batch
			? batch.error
			: batch.results
					.filter((result) => result.ok === false)
					.map((result) => {
						const applied =
							result.code === 'lifecycle_failed' && operation === 'auto-start' ? '策略已应用；' : ''
						return `${labelFor(result.address)}：${applied}${result.error}`
					})
					.join('\n')
	return {
		title: titles[operation][batch.status],
		message,
		color: batch.status === 'unknown' ? 'yellow' : 'red',
		autoClose: false as const,
		diagnosticText: JSON.stringify(batch, null, 2),
	}
}

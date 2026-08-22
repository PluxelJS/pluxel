import {
	parsePluginNodeAddress,
	pluginNodeIndexKey,
	type Context,
	type PluginNodeAddress,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import {
	PluginGraphRejectedError,
	PluginRestartUnavailableError,
	RuntimeStateMutationRejectedError,
	RuntimeStatePersistenceError,
	requireRuntimePluginGraphCoordinator,
	runtimeStatePatch,
} from '../../internal/reconciliation'
import { runtimePluginStatusOverview } from '../../runtime/capabilities'
import type {
	PluginStatusAction,
	PluginStatusBatchAction,
	PluginStatusBatchResult,
	PluginStatusMutationSuccess,
	PluginStatusMutationResult,
} from '../../web/protocol'
import { projectPluginApplyReport } from '../presenters/pluginApplyReport'

async function runStatusAction(
	ctx: Context,
	address: PluginNodeAddress,
	action: PluginStatusAction,
): Promise<PluginStatusMutationResult> {
	try {
		const coordinator = requireRuntimePluginGraphCoordinator(ctx)
		return await coordinator.runExclusive(`plugin-${action}`, async (session) => {
			if (action === 'restart') {
				const report = await session.update({
					reason: 'plugin-restart',
					restartNodes: [address],
					mode: 'live',
				})
				const isRunning = requirePluginService(ctx).isRunning(address)
				return {
					address,
					ok: true,
					status: 'applied',
					report: projectPluginApplyReport(ctx, report),
					isRunning,
					isEnabled: true,
					lifecycleStage: isRunning ? 'running' : 'stopped',
				}
			}
			if (
				!runtimePluginStatusOverview(ctx).statuses.some(
					(status) => pluginNodeIndexKey(status.address) === pluginNodeIndexKey(address),
				)
			) {
				return {
					address,
					ok: false,
					code: 'plugin_not_found',
					state: 'unchanged',
					error: 'Plugin node is unknown',
				}
			}
			let report
			switch (action) {
				case 'enable':
					report = await session.update({
						reason: 'plugin-enable',
						statePatch: runtimeStatePatch({
							type: 'set-enabled',
							node: address,
							enabled: true,
						}),
						mode: 'live',
					})
					break
				case 'disable':
					report = await session.update({
						reason: 'plugin-disable',
						statePatch: runtimeStatePatch({
							type: 'set-enabled',
							node: address,
							enabled: false,
						}),
						mode: 'live',
					})
					break
			}
			const snapshot = runtimePluginStatusOverview(ctx).statuses.find(
				(status) => pluginNodeIndexKey(status.address) === pluginNodeIndexKey(address),
			)
			if (!snapshot) {
				throw new Error('[runtime:status] applied Plugin node disappeared from status projection')
			}
			return {
				address,
				ok: true,
				status: 'applied',
				report: projectPluginApplyReport(ctx, report),
				isRunning: snapshot.isRunning,
				isEnabled: snapshot.isEnabled,
				lifecycleStage: snapshot.lifecycleStage,
			}
		})
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error)
		if (error instanceof RuntimeStatePersistenceError) {
			return {
				address,
				ok: false,
				code: 'persistence_failed',
				state: error.state,
				error: text,
			}
		}
		if (error instanceof PluginGraphRejectedError) {
			return {
				address,
				ok: false,
				code: 'graph_rejected',
				state: 'unchanged',
				error: text,
			}
		}
		if (error instanceof PluginRestartUnavailableError) {
			return {
				address,
				ok: false,
				code: error.code,
				state: error.state,
				error: text,
			}
		}
		if (error instanceof RuntimeStateMutationRejectedError) {
			return {
				address,
				ok: false,
				code: 'state_mutation_rejected',
				state: 'unchanged',
				error: text,
			}
		}
		throw error
	}
}

export async function applyStatusActions(
	ctx: Context,
	input: unknown,
): Promise<PluginStatusBatchResult> {
	const parsed = parseStatusActions(input)
	if (parsed.ok === false) {
		return {
			ok: false,
			status: 'rejected',
			code: 'invalid_input',
			state: 'unchanged',
			error: parsed.error,
			results: [],
		}
	}
	const actions = parsed.actions
	if (actions.length === 0) return { ok: true, status: 'applied', results: [] }
	const results: PluginStatusMutationResult[] = []
	for (const { address, action } of actions) {
		const result = await runStatusAction(ctx, address, action)
		results.push(result)
	}
	const successes = results.filter((result): result is PluginStatusMutationSuccess => result.ok)
	if (successes.length === results.length) {
		return { ok: true, status: 'applied', results: successes }
	}
	return {
		ok: false,
		status: successes.length > 0 ? 'partially-applied' : 'rejected',
		results,
	}
}

function parseStatusActions(
	input: unknown,
):
	| Readonly<{ ok: true; actions: PluginStatusBatchAction[] }>
	| Readonly<{ ok: false; error: string }> {
	if (!Array.isArray(input)) {
		return { ok: false, error: 'Plugin status actions must be an array' }
	}
	const actions: PluginStatusBatchAction[] = []
	for (const [index, value] of input.entries()) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return { ok: false, error: `Plugin status action at index ${index} must be an object` }
		}
		const record = value as Record<string, unknown>
		if (record.action !== 'enable' && record.action !== 'disable' && record.action !== 'restart') {
			return { ok: false, error: `Plugin status action at index ${index} is invalid` }
		}
		let address: PluginNodeAddress
		try {
			address = parsePluginNodeAddress(record.address)
		} catch {
			return { ok: false, error: `Plugin status address at index ${index} is invalid` }
		}
		actions.push({ address, action: record.action })
	}
	return { ok: true, actions }
}

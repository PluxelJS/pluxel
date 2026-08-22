import {
	parsePluginNodeAddress,
	type Context,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { requireConfigService, requirePluginService } from '@pluxel/core/internal'
import {
	PluginGraphRejectedError,
	RuntimeStateMutationRejectedError,
	RuntimeStatePersistenceError,
	requireRuntimePluginGraphCoordinator,
	runtimeStatePatch,
	type PluginApplyReport,
} from '../../internal/reconciliation'
import { listForkIds } from '../../services/RuntimeStateHelpers'
import { getContextRuntimeLogging } from '../../logger/logging'
import { ConfigMutationRejectedError } from '../../services/ConfigService'

class ForkMetadataPersistenceError extends Error {
	constructor(
		public readonly backend: 'config' | 'logging',
		cause: unknown,
	) {
		super(`[runtime:fork] failed to persist ${backend} metadata cleanup`, { cause })
		this.name = 'ForkMetadataPersistenceError'
	}
}

export type ForkEnsureResult =
	| {
			ok: true
			status: 'applied' | 'deferred'
			node: PluginNodeAddress
			report: PluginApplyReport
	  }
	| {
			ok: true
			status: 'saved-not-applied'
			node: PluginNodeAddress
			report: PluginApplyReport
			applicationFailure: {
				code: 'plugin_not_running_after_enable'
				message: string
			}
	  }
	| {
			ok: false
			code:
				| 'invalid_fork_id'
				| 'definition_unavailable'
				| 'not_forkable'
				| 'consumer_unavailable'
				| 'provider_unavailable'
				| 'requirement_not_found'
				| 'provider_incompatible'
				| 'graph_rejected'
			state: 'unchanged'
			message: string
	  }
	| {
			ok: false
			code: 'persistence_failed'
			state: 'unknown'
			message: string
	  }

export type ForkRemoveResult =
	| {
			ok: true
			status: 'removed' | 'removed-with-lifecycle-issues'
			node: PluginNodeAddress
			report: PluginApplyReport
	  }
	| { ok: true; status: 'already-absent'; node: PluginNodeAddress }
	| {
			ok: false
			code: 'fork_referenced'
			state: 'unchanged'
			references: readonly Readonly<{
				consumer: PluginNodeAddress
				requirement: PluginDefinitionAddress
			}>[]
			message: string
	  }
	| {
			ok: false
			code: 'invalid_fork_id' | 'graph_rejected'
			state: 'unchanged'
			message: string
	  }
	| {
			ok: false
			code: 'persistence_failed'
			state: 'retained' | 'disabled-retained' | 'unknown'
			node: PluginNodeAddress
			report?: PluginApplyReport
			message: string
	  }

export async function ensureFork(
	ctx: Context,
	base: PluginNodeAddress,
	forkId: string,
	options: {
		enable?: boolean
		selectFor?: Readonly<{
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
		}>
	} = {},
): Promise<ForkEnsureResult> {
	const node = parseForkAddress(base, forkId)
	if (!node) return invalidFork('Fork base or forkId is invalid')
	const coordinator = requireRuntimePluginGraphCoordinator(ctx)
	try {
		const enabled = options.enable !== false
		const report = await coordinator.updateRuntimeState(
			runtimeStatePatch(
				{ type: 'ensure-fork', definition: node.definition, forkId: node.forkId },
				{ type: 'set-enabled', node, enabled },
				...(options.selectFor
					? [
							{
								type: 'set-dependency-override' as const,
								consumer: options.selectFor.consumer,
								requirement: options.selectFor.requirement,
								provider: node,
							},
						]
					: []),
			),
			'fork-ensure',
		)
		if (!enabled) return { ok: true, status: 'deferred', node, report }
		if (requirePluginService(ctx).isRunning(node)) {
			return { ok: true, status: 'applied', node, report }
		}
		return {
			ok: true,
			status: 'saved-not-applied',
			node,
			report,
			applicationFailure: {
				code: 'plugin_not_running_after_enable',
				message: 'Fork was saved and enabled, but its Plugin generation is not running.',
			},
		}
	} catch (error) {
		return forkMutationFailure(error)
	}
}

export async function removeFork(
	ctx: Context,
	base: PluginNodeAddress,
	forkId: string,
): Promise<ForkRemoveResult> {
	const node = parseForkAddress(base, forkId)
	if (!node) return invalidFork('Fork base or forkId is invalid')
	const coordinator = requireRuntimePluginGraphCoordinator(ctx)
	let disableReport: PluginApplyReport | undefined
	let phase: 'admission' | 'disable' | 'metadata' | 'remove' = 'admission'
	try {
		return await coordinator.runExclusive('fork-remove', async (session) => {
			const state = session.runtimeStateSnapshot()
			if (!listForkIds(state, node.definition).includes(node.forkId)) {
				return { ok: true, status: 'already-absent', node }
			}
			const removalPatch = runtimeStatePatch(
				{ type: 'remove-node-policy', node },
				{ type: 'remove-fork', definition: node.definition, forkId: node.forkId },
			)
			session.validateRuntimeStatePatch(removalPatch)
			phase = 'disable'
			disableReport = await session.update({
				statePatch: runtimeStatePatch({ type: 'set-enabled', node, enabled: false }),
				reason: 'fork-remove-disable',
				mode: 'live',
			})
			phase = 'metadata'
			await deleteForkConfig(ctx, node)
			await deleteForkLoggingPolicy(ctx, node)
			phase = 'remove'
			const finalReport = await session.update({
				statePatch: removalPatch,
				reason: 'fork-remove-metadata',
				mode: 'live',
			})
			const report = combineRemovalReports(disableReport, finalReport)
			return {
				ok: true,
				status: hasDrainIssues(disableReport) ? 'removed-with-lifecycle-issues' : 'removed',
				node,
				report,
			}
		})
	} catch (error) {
		return removeFailure(
			error,
			node,
			phase === 'admission' ? 'retained' : phase === 'metadata' ? 'disabled-retained' : 'unknown',
			disableReport,
		)
	}
}

function parseForkAddress(
	base: PluginNodeAddress,
	forkId: string,
): Extract<PluginNodeAddress, { variant: 'fork' }> | undefined {
	if (base.variant !== 'default') return undefined
	try {
		const parsed = parsePluginNodeAddress({
			definition: base.definition,
			variant: 'fork',
			forkId,
		})
		return parsed.variant === 'fork' ? parsed : undefined
	} catch {
		return undefined
	}
}

function invalidFork(message: string): ForkEnsureResult & ForkRemoveResult {
	return { ok: false, code: 'invalid_fork_id', state: 'unchanged', message }
}

function forkMutationFailure(error: unknown): ForkEnsureResult {
	if (
		error instanceof RuntimeStateMutationRejectedError &&
		(error.code === 'definition_unavailable' ||
			error.code === 'not_forkable' ||
			error.code === 'consumer_unavailable' ||
			error.code === 'provider_unavailable' ||
			error.code === 'requirement_not_found' ||
			error.code === 'provider_incompatible')
	) {
		return {
			ok: false,
			code: error.code,
			state: 'unchanged',
			message: error.issue.message,
		}
	}
	if (error instanceof PluginGraphRejectedError) {
		return {
			ok: false,
			code: 'graph_rejected',
			state: 'unchanged',
			message: error.message,
		}
	}
	if (error instanceof RuntimeStatePersistenceError) {
		return {
			ok: false,
			code: 'persistence_failed',
			state: error.state,
			message: error.message,
		}
	}
	throw error
}

function removeFailure(
	error: unknown,
	node: PluginNodeAddress,
	state: 'retained' | 'disabled-retained' | 'unknown',
	report?: PluginApplyReport,
): ForkRemoveResult {
	if (
		error instanceof RuntimeStateMutationRejectedError &&
		error.issue.code === 'fork_referenced'
	) {
		return {
			ok: false,
			code: 'fork_referenced',
			state: 'unchanged',
			references: error.issue.references,
			message: error.issue.message,
		}
	}
	if (error instanceof PluginGraphRejectedError) {
		return {
			ok: false,
			code: 'graph_rejected',
			state: 'unchanged',
			message: error.message,
		}
	}
	if (error instanceof RuntimeStatePersistenceError) {
		return {
			ok: false,
			code: 'persistence_failed',
			state: 'unknown',
			node,
			...(report ? { report } : {}),
			message: error.message,
		}
	}
	if (error instanceof ForkMetadataPersistenceError) {
		return {
			ok: false,
			code: 'persistence_failed',
			state,
			node,
			...(report ? { report } : {}),
			message: error.message,
		}
	}
	throw error
}

function hasDrainIssues(report: PluginApplyReport | undefined): boolean {
	if (!report) return false
	if (report.core.status !== 'committed') return false
	return report.core.summary.lifecycleReport.issues.some((issue) => issue.phase === 'drain')
}

async function deleteForkConfig(ctx: Context, node: PluginNodeAddress): Promise<void> {
	const configService = requireConfigService(ctx)
	try {
		configService.deleteConfig(node)
	} catch (error) {
		if (error instanceof ConfigMutationRejectedError) {
			throw new ForkMetadataPersistenceError('config', error)
		}
		throw error
	}
	try {
		await configService.flush()
	} catch (error) {
		throw new ForkMetadataPersistenceError('config', error)
	}
}

async function deleteForkLoggingPolicy(ctx: Context, node: PluginNodeAddress): Promise<void> {
	const logging = getContextRuntimeLogging(ctx)
	if (!logging) return
	const mutation = logging.policy.clearPluginLevel(node)
	if (mutation.persistence === 'failed') {
		// A previous cleanup may have updated memory but failed durably; force an idempotent retry.
		logging.policy.replace(logging.policy.snapshot())
	}
	await logging.policy.flush()
	if (logging.policy.persistence === 'failed') {
		throw new ForkMetadataPersistenceError(
			'logging',
			logging.policy.lastPersistenceError ?? new Error('logging policy persistence failed'),
		)
	}
}

function combineRemovalReports(
	disableReport: PluginApplyReport | undefined,
	finalReport: PluginApplyReport,
): PluginApplyReport {
	if (!disableReport || finalReport.core.status === 'committed') return finalReport
	return Object.freeze({
		catalogRevision: finalReport.catalogRevision,
		runtimeStateRevision: finalReport.runtimeStateRevision,
		reconciliation: finalReport.reconciliation,
		core: disableReport.core,
	})
}

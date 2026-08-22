import {
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	type CommitSummary,
	type Context,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import type {
	PluginApplyReport as InternalPluginApplyReport,
	PluginReconciliationIssue as InternalPluginReconciliationIssue,
} from '../../internal/reconciliation'
import type {
	PluginApplyLifecycleErrorInfo,
	PluginApplyLifecycleIssue,
	PluginApplyReport,
	PluginReconciliationIssue,
} from '../../web/protocol'

/** Projects runtime/Core identities into the address-only browser control-plane contract. */
export function projectPluginApplyReport(
	ctx: Context,
	report: InternalPluginApplyReport<CommitSummary>,
): PluginApplyReport {
	const plugins = requirePluginService(ctx)
	const summary = report.core.status === 'committed' ? report.core.summary : undefined
	return Object.freeze({
		catalogRevision: report.catalogRevision,
		runtimeStateRevision: report.runtimeStateRevision,
		reconciliation: Object.freeze(report.reconciliation.map(projectReconciliationIssue)),
		core:
			summary === undefined
				? Object.freeze({ status: 'unchanged' as const })
				: Object.freeze({
						status: 'committed' as const,
						summary: Object.freeze({
							pluginChanges: Object.freeze({
								added: Object.freeze(
									summary.pluginChanges.added.map((slot) =>
										projectNodeAddress(plugins.nodeAddressOf(slot)),
									),
								),
								replaced: Object.freeze(
									summary.pluginChanges.replaced.map(({ from, to }) =>
										Object.freeze({
											from: projectNodeAddress(plugins.nodeAddressOf(from)),
											to: projectNodeAddress(plugins.nodeAddressOf(to)),
										}),
									),
								),
								removed: Object.freeze(
									summary.pluginChanges.removed.map((slot) =>
										projectNodeAddress(plugins.nodeAddressOf(slot)),
									),
								),
								restarted: Object.freeze(
									summary.pluginChanges.restarted.map((slot) =>
										projectNodeAddress(plugins.nodeAddressOf(slot)),
									),
								),
								availabilityChanged: Object.freeze(
									summary.pluginChanges.availabilityChanged.map((slot) =>
										projectNodeAddress(plugins.nodeAddressOf(slot)),
									),
								),
							}),
							runtimeUpdate: Object.freeze(
								summary.runtimeUpdate.reason === undefined
									? {}
									: { reason: summary.runtimeUpdate.reason },
							),
							lifecycleReport: Object.freeze({
								ok: summary.lifecycleReport.ok,
								issues: Object.freeze(
									summary.lifecycleReport.issues.map(
										(issue): PluginApplyLifecycleIssue =>
											Object.freeze({
												plugin: projectNodeAddress(plugins.nodeAddressOf(issue.plugin)),
												phase: issue.phase,
												kind: issue.kind,
												message: issue.message,
												...(issue.error ? { error: projectLifecycleError(issue.error) } : {}),
												...(issue.blockedBy
													? {
															blockedBy: projectNodeAddress(plugins.nodeAddressOf(issue.blockedBy)),
														}
													: {}),
											}),
									),
								),
							}),
						}),
					}),
	})
}

function projectLifecycleError(
	error: CommitSummary['lifecycleReport']['issues'][number]['error'] & {},
): PluginApplyLifecycleErrorInfo {
	return Object.freeze({
		name: error.name,
		message: error.message,
		...(error.stack === undefined ? {} : { stack: error.stack }),
		...(error.cause === undefined ? {} : { cause: error.cause }),
		...(error.partPath === undefined ? {} : { partPath: Object.freeze([...error.partPath]) }),
	})
}

function projectReconciliationIssue(
	issue: InternalPluginReconciliationIssue,
): PluginReconciliationIssue {
	switch (issue.kind) {
		case 'consumer_unavailable':
			return Object.freeze({
				kind: issue.kind,
				consumer: projectNodeAddress(issue.consumer),
				message: issue.message,
			})
		case 'requirement_removed':
			return Object.freeze({
				kind: issue.kind,
				binding: issue.binding,
				consumer: projectNodeAddress(issue.consumer),
				requirement: projectDefinitionAddress(issue.requirement),
				provider: projectNodeAddress(issue.provider),
				message: issue.message,
			})
		case 'provider_unavailable':
		case 'provider_disabled':
		case 'provider_incompatible':
		case 'explicit_binding_invalid':
			return Object.freeze({
				kind: issue.kind,
				binding: issue.binding,
				...(issue.consumer === undefined ? {} : { consumer: projectNodeAddress(issue.consumer) }),
				requirement: projectDefinitionAddress(issue.requirement),
				provider: projectNodeAddress(issue.provider),
				message: issue.message,
			})
		case 'fork_not_allowed':
			return Object.freeze({
				kind: issue.kind,
				node: projectNodeAddress(issue.node),
				message: issue.message,
			})
		case 'fork_default_forbidden':
		case 'provider_default_requires_abstract':
			return Object.freeze({
				kind: issue.kind,
				requirement: projectDefinitionAddress(issue.requirement),
				provider: projectNodeAddress(issue.provider),
				message: issue.message,
			})
		case 'missing_required_provider':
			return Object.freeze({
				kind: issue.kind,
				consumer: projectNodeAddress(issue.consumer),
				requirement: projectDefinitionAddress(issue.requirement),
				message: issue.message,
			})
	}
}

function projectNodeAddress(address: PluginNodeAddress): PluginNodeAddress {
	return parsePluginNodeAddress(address)
}

function projectDefinitionAddress(address: PluginDefinitionAddress): PluginDefinitionAddress {
	return parsePluginDefinitionAddress(address)
}

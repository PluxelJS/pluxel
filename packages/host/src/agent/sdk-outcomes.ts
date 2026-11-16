import type { PluginNodeAddress } from '@pluxel/core'
import type { LogReadResult } from '@pluxel/core/logging'
import type {
	HostPluginConfigResult,
	HostPluginConfigResultErr,
	HostPluginConfigResultOk,
} from '../config'
import type { HostPolicyResult } from '../policy-management'
import type { PluginApplyReportSnapshot } from '../apply-report'
import type { PluginReconciliationIssue } from '../reconcile'
import { pluginApplyReportOutcome } from '../report-protocol'
import type { ScriptPluginListError } from './discovery'

type WithoutOk<T> = T extends unknown ? Readonly<Omit<T, 'ok'>> : never

/** Expected run admission failure details. Unknown implementation defects retain their original error. */
export type ScriptRunError = Readonly<{
	code: 'scope_closed' | 'cancelled'
	message: string
}>

/** Await business work before queueing Host operations, and vice versa. */
export type ScriptOperationError =
	| ScriptRunError
	| Readonly<{
			code: 'borrowed_generation_conflict'
			message: string
	  }>

/** Reimport the current constructor when an explicitly selected implementation changes. */
export type ScriptTargetError = Readonly<{
	code: 'target_unavailable' | 'stale_target'
	message: string
}>

export type ScriptControlError = Readonly<{
	code:
		| 'stale_target'
		| 'control_evidence_missing'
		| 'control_format_unsupported'
		| 'control_material_unavailable'
		| 'control_contract_mismatch'
	message: string
}>

/** Schema output and complete persistence/adoption facts, without a second success flag. */
export type ScriptConfigSnapshot<O extends object = Readonly<Record<string, unknown>>> = WithoutOk<
	HostPluginConfigResultOk<PluginApplyReportSnapshot, O>
>

/** Persistence failure retains state: unknown; it does not authorize a retry. */
export type ScriptConfigError =
	| WithoutOk<HostPluginConfigResultErr>
	| ScriptOperationError
	| ScriptControlError

export type ScriptPolicySnapshot = WithoutOk<
	Extract<HostPolicyResult<PluginApplyReportSnapshot>, { ok: true }>
>
export type ScriptPolicyError =
	| WithoutOk<Extract<HostPolicyResult<PluginApplyReportSnapshot>, { ok: false }>>
	| ScriptOperationError

export type ScriptInstanceError =
	| ScriptOperationError
	| ScriptControlError
	| ScriptTargetError
	| Readonly<{
			code: 'plugin_not_running'
			message: string
	  }>

/** Lifecycle failures retain the complete report, including changes already committed. */
export type ScriptLifecycleError =
	| ScriptOperationError
	| ScriptTargetError
	| Readonly<{ code: 'lifecycle_failed'; message: string; report: PluginApplyReportSnapshot }>
	| Readonly<{
			code: 'graph_rejected'
			message: string
			state: 'unchanged'
			issues: readonly PluginReconciliationIssue[]
	  }>
	| Readonly<{
			code: 'persistence_failed'
			message: string
			state: 'unknown'
			report?: PluginApplyReportSnapshot
	  }>
	| Readonly<{
			code: 'start_unavailable' | 'restart_unavailable'
			message: string
			state: 'unchanged'
			address: PluginNodeAddress
	  }>

export type ScriptLogSnapshot = WithoutOk<Extract<LogReadResult, { ok: true }>>
type ScriptLogReadError = WithoutOk<Extract<LogReadResult, { ok: false }>> &
	Readonly<{ message: string }>
export type ScriptLogError =
	| ScriptLogReadError
	| ScriptRunError
	| Readonly<{
			code: 'logging_unavailable' | 'store_unavailable'
			message: string
	  }>

/** Expected control failure facts. Each domain retains its original discriminant and reports. */
export type ScriptErrorDetails =
	| ScriptConfigError
	| ScriptPolicyError
	| ScriptInstanceError
	| ScriptLifecycleError
	| ScriptLogError
	| ScriptPluginListError

/** One throwing contract for SDK control operations, in-process and in execution receipts. */
export class ScriptError extends Error {
	readonly details: ScriptErrorDetails

	constructor(details: ScriptErrorDetails, options?: ErrorOptions) {
		super(details.message, options)
		this.name = 'ScriptError'
		this.details = Object.freeze({ ...details })
	}

	get code(): ScriptErrorDetails['code'] {
		return this.details.code
	}
}

/** Project one existing domain outcome; failures keep all facts on ScriptError.details. */
export function scriptConfigSnapshot<O extends object>(
	input: HostPluginConfigResult<PluginApplyReportSnapshot, O>,
): ScriptConfigSnapshot<O> {
	if (input.ok === false) {
		const { ok: _ok, ...error } = input
		throw new ScriptError(error)
	}
	const { ok: _ok, ...value } = input
	return Object.freeze(value)
}

export function scriptPolicySnapshot(
	input: HostPolicyResult<PluginApplyReportSnapshot>,
): ScriptPolicySnapshot {
	if (input.ok === false) {
		const { ok: _ok, ...error } = input
		throw new ScriptError(error)
	}
	const { ok: _ok, ...value } = input
	return Object.freeze(value)
}

export function scriptLogSnapshot(input: LogReadResult): ScriptLogSnapshot {
	if (input.ok === false) {
		const { ok: _ok, ...error } = input
		const messages = {
			root_mismatch: 'Log cursor belongs to a different Host',
			stream_replaced: 'Log stream has been replaced; obtain a new cursor',
			store_unavailable: 'Log store is not available for this cursor',
			epoch_mismatch: 'Log store has been reset; obtain a new cursor',
			from_too_old: 'Log cursor precedes the retained history',
			invalid: 'Log range is invalid',
		}
		throw new ScriptError({
			...error,
			message: ('message' in error ? error.message : undefined) ?? messages[error.code],
		})
	}
	const { ok: _ok, ...value } = input
	return Object.freeze(value)
}

export function scriptLifecycleReport(
	report: PluginApplyReportSnapshot,
): PluginApplyReportSnapshot {
	const outcome = pluginApplyReportOutcome(report)
	if (outcome.status === 'applied') return outcome.report
	if (outcome.status === 'persistence_failed')
		throw new ScriptError({
			code: outcome.status,
			message: outcome.message,
			state: outcome.state,
			report: outcome.report,
		})
	throw new ScriptError({ code: outcome.status, message: outcome.message, report: outcome.report })
}

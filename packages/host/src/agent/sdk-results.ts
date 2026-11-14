import { Result } from '@pluxel/core/better-result'
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

type WithoutOk<T> = T extends unknown ? Readonly<Omit<T, 'ok'>> : never

/** Expected run admission failures. Unknown implementation defects still reject. */
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

/** Synchronize control materials again before using an incompatible descriptor. */
export type ScriptControlError = Readonly<{
	code: 'control_format_unsupported' | 'control_material_unavailable' | 'control_contract_mismatch'
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
	| Readonly<{ code: 'persistence_failed'; message: string; state: 'unknown' }>
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

/** Project exactly one existing domain result at the SDK boundary. */
export function scriptConfigResult<O extends object>(
	input: HostPluginConfigResult<PluginApplyReportSnapshot, O>,
): Result<ScriptConfigSnapshot<O>, WithoutOk<HostPluginConfigResultErr>> {
	if (input.ok === false) {
		const { ok: _ok, ...error } = input
		return Result.err(Object.freeze(error))
	}
	const { ok: _ok, ...value } = input
	return Result.ok(Object.freeze(value))
}

export function scriptPolicyResult(
	input: HostPolicyResult<PluginApplyReportSnapshot>,
): Result<ScriptPolicySnapshot, WithoutOk<Extract<HostPolicyResult, { ok: false }>>> {
	if (input.ok === false) {
		const { ok: _ok, ...error } = input
		return Result.err(Object.freeze(error))
	}
	const { ok: _ok, ...value } = input
	return Result.ok(Object.freeze(value))
}

export function scriptLogResult(
	input: LogReadResult,
): Result<ScriptLogSnapshot, ScriptLogReadError> {
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
		return Result.err(
			Object.freeze({
				...error,
				message: ('message' in error ? error.message : undefined) ?? messages[error.code],
			}),
		)
	}
	const { ok: _ok, ...value } = input
	return Result.ok(Object.freeze(value))
}

export function scriptLifecycleResult(
	report: PluginApplyReportSnapshot,
): Result<PluginApplyReportSnapshot, Extract<ScriptLifecycleError, { code: 'lifecycle_failed' }>> {
	if (
		report.reconciliation.length > 0 ||
		(report.core.status === 'committed' && !report.core.summary.lifecycleReport.ok)
	)
		return Result.err(
			Object.freeze({
				code: 'lifecycle_failed',
				message:
					'Plugin lifecycle application completed with issues; inspect the report before continuing',
				report,
			}),
		)
	return Result.ok(report)
}

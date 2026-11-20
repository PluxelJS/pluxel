import type { Context } from '@pluxel/core'
import {
	HostStatePersistenceError,
	PluginGraphRejectedError,
	type HostOperationOptions,
	type PluginApplyReport,
} from './coordinator'
import { requirePluginHostCoordinator } from './install'
import { validateHostPolicyChange, HostStateMutationRejectedError } from './mutation'
import type { HostPolicyInput, HostPolicyPatch, HostPolicyResetTarget } from './policy'
import {
	applyHostPolicyPatch,
	canonicalHostPolicyPatch,
	HostPolicyInputError,
} from './policy-input'
import {
	hostPolicyInputEqual,
	HostPolicyMutationRejectedError,
	HostPolicyRevisionConflictError,
	type HostStateConfigurationSnapshot,
	type HostStateStore,
} from './state-store'
import type { HostPersistenceResult } from './persistence'

export type HostPolicyResult<TReport = PluginApplyReport> =
	| (HostStateConfigurationSnapshot &
			Readonly<{ ok: true; persistence: HostPersistenceResult; report?: TReport }>)
	| Readonly<{
			ok: false
			code:
				| 'invalid_input'
				| 'validation_failed'
				| 'mutation_rejected'
				| 'revision_conflict'
				| 'persistence_failed'
			state: 'unchanged' | 'unknown'
			message: string
			managedRevision?: string
			persistence: HostPersistenceResult
	  }>
export interface HostPolicy {
	get(options?: HostOperationOptions): Promise<HostPolicyResult>
	validate(values: HostPolicyPatch, options?: HostOperationOptions): Promise<HostPolicyResult>
	patch(values: HostPolicyPatch, options?: HostOperationOptions): Promise<HostPolicyResult>
	reset(
		keys?: readonly HostPolicyResetTarget[],
		options?: HostOperationOptions,
	): Promise<HostPolicyResult>
}

export function createHostPolicy(ctx: Context, store: HostStateStore): HostPolicy {
	const coordinator = requirePluginHostCoordinator(ctx)
	const result = (input = store.managedSnapshot(), report?: PluginApplyReport): HostPolicyResult =>
		Object.freeze({
			ok: true,
			...store.configurationSnapshot(input),
			persistence: report?.persistence ?? Object.freeze({ status: 'unchanged' }),
			...(report ? { report } : {}),
		})
	const mutate = async (
		candidate: (current: HostPolicyInput) => HostPolicyInput,
		options?: HostOperationOptions,
	): Promise<HostPolicyResult> => {
		try {
			return await coordinator.runExclusive(
				'policy-edit',
				async (session) => {
					store.assertManagedRevision(options?.expectedManagedRevision)
					const input = candidate(store.managedSnapshot())
					if (hostPolicyInputEqual(input, store.managedSnapshot())) return result()
					store.assertMutable()
					const report = await session.update({ policyInput: input, reason: 'policy-edit' })
					return result(store.managedSnapshot(), report)
				},
				options,
			)
		} catch (error) {
			if (options?.signal?.aborted && error === options.signal.reason) throw error
			return failure(error)
		}
	}
	const patch = async (
		values: HostPolicyPatch,
		options?: HostOperationOptions,
	): Promise<HostPolicyResult> => {
		let edit: HostPolicyPatch
		try {
			edit = canonicalHostPolicyPatch(values)
		} catch (error) {
			return failure(error)
		}
		return mutate((current) => applyHostPolicyPatch(current, edit), options)
	}
	return Object.freeze({
		get: (options?: HostOperationOptions) => coordinator.readCommitted(() => result(), options),
		async validate(values: HostPolicyPatch, options?: HostOperationOptions) {
			try {
				const edit = canonicalHostPolicyPatch(values)
				return await coordinator.readCommitted((view) => {
					store.assertManagedRevision(options?.expectedManagedRevision)
					const input = applyHostPolicyPatch(store.managedSnapshot(), edit)
					validateHostPolicyChange(
						view.catalog,
						view.runtimeState.state,
						store.effectiveSnapshot(input),
					)
					return result(input)
				}, options)
			} catch (error) {
				if (options?.signal?.aborted && error === options.signal.reason) throw error
				return failure(error)
			}
		},
		patch,
		reset(keys?: readonly HostPolicyResetTarget[], options?: HostOperationOptions) {
			return keys === undefined
				? mutate(() => Object.freeze({}), options)
				: patch({ reset: keys }, options)
		},
	})
}
function failure(error: unknown): HostPolicyResult {
	const unchanged = {
		ok: false as const,
		state: 'unchanged' as const,
		persistence: Object.freeze({ status: 'unchanged' as const }),
	}
	if (error instanceof HostPolicyRevisionConflictError)
		return Object.freeze({
			...unchanged,
			code: 'revision_conflict',
			message: error.message,
			managedRevision: error.managedRevision,
		})
	if (error instanceof HostPolicyMutationRejectedError)
		return Object.freeze({ ...unchanged, code: 'mutation_rejected', message: error.message })
	if (error instanceof HostStatePersistenceError)
		return Object.freeze({
			ok: false,
			code: 'persistence_failed',
			state: 'unknown',
			persistence: Object.freeze({ status: 'unknown' }),
			message: error.message,
		})
	if (error instanceof HostStateMutationRejectedError || error instanceof PluginGraphRejectedError)
		return Object.freeze({ ...unchanged, code: 'validation_failed', message: error.message })
	if (error instanceof HostPolicyInputError)
		return Object.freeze({ ...unchanged, code: 'invalid_input', message: error.message })
	throw error
}

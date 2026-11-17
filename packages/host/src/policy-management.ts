import type { Context } from '@pluxel/core'
import {
	HostStatePersistenceError,
	PluginGraphRejectedError,
	type HostOperationOptions,
	type PluginApplyReport,
} from './coordinator'
import { requirePluginHostCoordinator } from './install'
import { validateHostPolicyChange, HostStateMutationRejectedError } from './mutation'
import { HOST_POLICY_FIELDS, type HostPolicyInput, type HostPolicyField } from './policy'
import {
	canonicalHostPolicyInput,
	snapshotPolicyArray,
	hostPolicyInputEqual,
	HostPolicyMutationRejectedError,
	HostPolicyInputError,
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
	validate(values: HostPolicyInput, options?: HostOperationOptions): Promise<HostPolicyResult>
	patch(values: HostPolicyInput, options?: HostOperationOptions): Promise<HostPolicyResult>
	reset(
		keys?: readonly HostPolicyField[],
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
					validateHostPolicyChange(
						coordinator.catalogSnapshot(),
						session.runtimeStateSnapshot(),
						store.effectiveSnapshot(input),
					)
					const report = await session.update({ policyInput: input, reason: 'policy-edit' })
					return result(store.managedSnapshot(), report)
				},
				options,
			)
		} catch (error) {
			return failure(error)
		}
	}
	return Object.freeze({
		get: (options?: HostOperationOptions) => coordinator.readCommitted(() => result(), options),
		async validate(values: HostPolicyInput, options?: HostOperationOptions) {
			try {
				const patch = canonicalHostPolicyInput(values)
				return await coordinator.readCommitted((view) => {
					const input = canonicalHostPolicyInput({ ...store.managedSnapshot(), ...patch })
					validateHostPolicyChange(
						view.catalog,
						view.runtimeState.state,
						store.effectiveSnapshot(input),
					)
					return result(input)
				}, options)
			} catch (error) {
				return failure(error)
			}
		},
		async patch(values: HostPolicyInput, options?: HostOperationOptions) {
			let patch: HostPolicyInput
			try {
				patch = canonicalHostPolicyInput(values)
			} catch (error) {
				return failure(error)
			}
			return mutate((current) => canonicalHostPolicyInput({ ...current, ...patch }), options)
		},
		async reset(keys?: readonly HostPolicyField[], options?: HostOperationOptions) {
			let selected: readonly HostPolicyField[]
			try {
				selected =
					keys === undefined ? HOST_POLICY_FIELDS : snapshotPolicyArray(keys, 'policy reset keys')
				if (
					selected.some((key) => !(HOST_POLICY_FIELDS as readonly string[]).includes(key)) ||
					new Set(selected).size !== selected.length
				)
					throw new HostPolicyInputError('[host] policy reset requires distinct policy field names')
			} catch (error) {
				return failure(error)
			}

			return mutate(
				(current) =>
					canonicalHostPolicyInput(
						Object.fromEntries(
							Object.entries(current).filter(
								([key]) => !(selected as readonly string[]).includes(key),
							),
						),
					),
				options,
			)
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

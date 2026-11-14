import {
	parsePluginNodeAddress,
	pluginNodeIndexKey,
	pluginDefinitionAddressEqual,
	type PluginConstructor,
	type PluginNodeAddress,
	type RootContext,
} from '@pluxel/core'
import { Result } from '@pluxel/core/better-result'
import {
	getPluginGenerationContext,
	requirePluginGenerationInfo,
	requirePluginService,
	requireConfigService,
	CorePluginGraphVerificationError,
} from '@pluxel/core/internal'
import {
	Logging,
	markLogs,
	readLogs,
	waitForLogs,
	type RuntimeLogging,
	type LogCursor,
	type LogReadOptions,
} from '@pluxel/core/logging'
import { requirePluginHostCoordinator } from '../install'
import {
	projectPluginApplyReport,
	projectPluginConfigResult,
	projectHostPolicyResult,
} from '../apply-report'
import {
	pluginConfigGet,
	pluginConfigValidate,
	pluginConfigPatch,
	pluginConfigReset,
	type HostConfigMutation,
} from '../config'
import { createHostPolicy } from '../policy-management'
import { requireHostStateStore } from '../host'
import { hostPluginStatusOverviewFromView } from '../status'
import { readHostPluginLifecycleIssues } from '../diagnostics'
import { readHostRecentUpdates } from '../recent-update'
import {
	pluginLifecycleUpdate,
	PluginGraphRejectedError,
	HostStatePersistenceError,
	PluginStartUnavailableError,
	PluginRestartUnavailableError,
	type HostOperationOptions,
	type HostPluginGraphCommittedView,
} from '../coordinator'
import type { HostConfigStore } from '../config-store'
import type { HostPolicyField, HostPolicyInput } from '../policy'
import type { ScriptPlugin, ScriptSdk } from './sdk-types'
import type { PluginTarget, ScriptLogReadOptions } from './control'
import { normalizePluginTarget } from './control-target'
import { createPluginInstanceView } from './instance-view'
import {
	assertPluginControlContract,
	pluginCatalogEntry,
	PluginControlError,
	type PluginCatalogSnapshot,
} from '../catalog'
import { ScriptExecutionError } from './protocol'
import {
	scriptConfigResult,
	scriptPolicyResult,
	scriptLifecycleResult,
	scriptLogResult,
	type ScriptRunError,
	type ScriptOperationError,
	type ScriptControlError,
	type ScriptTargetError,
	type ScriptInstanceError,
	type ScriptLifecycleError,
	type ScriptLogError,
} from './sdk-results'

type ConstructorPlugin = Omit<ScriptPlugin<PluginNodeAddress>, 'config' | 'fork'> &
	Readonly<{
		fork: (forkId: string) => ConstructorPlugin
		instance: () => Promise<Result<object, ScriptInstanceError>>
	}>

export class ScriptScopeError extends Error {
	constructor(
		readonly code:
			| 'scope_closed'
			| 'logging_unavailable'
			| 'store_unavailable'
			| 'borrowed_generation_conflict',
		message: string,
	) {
		super(message)
		this.name = 'ScriptScopeError'
	}
}

export type ScriptRevisions = Readonly<{
	catalogRevision: number
	runtimeStateRevision: number
	configManagedRevision: string
	policyManagedRevision: string
}>

export interface ScriptScope {
	readonly sdk: ScriptSdk
	/** Guard trusted in-process extensions at the same run admission boundary. */
	assertOpen(): void
	/** @internal Bind a trusted project constructor to this same scope and committed Host queue. */
	selectPlugin(
		node: PluginNodeAddress,
		expectedImplementation: PluginConstructor,
	): ConstructorPlugin
	/** Close admission and signal cooperative cancellation; accepted operations still settle. */
	abort(reason?: unknown): void
	/** Idempotent. Drains tracked calls and releases subscriptions; never closes the Host. */
	dispose(): Promise<void>
	/** Internal execution metadata; remains readable after this scope has closed. */
	snapshot(): Promise<ScriptRevisions>
}

/** Borrow a started Host. No Services, compiler, transport, log backend or new root is installed. */
export function createScriptScope(
	options: Readonly<{ ctx: RootContext; signal?: AbortSignal }>,
): ScriptScope {
	const { ctx, signal } = options
	const coordinator = requirePluginHostCoordinator(ctx)
	const state = requireHostStateStore(ctx)
	const policy = createHostPolicy(ctx, state)
	const controller = new AbortController()
	const pending = new Set<Promise<unknown>>()
	const views = new WeakMap<object, object>()
	const originals = new WeakMap<object, object>()
	const unwrap = (value: unknown): unknown =>
		value !== null && (typeof value === 'object' || typeof value === 'function')
			? (originals.get(value) ?? value)
			: value
	let activeCalls = 0
	let queuedCalls = 0
	let disposal: Promise<void> | undefined
	const abort = (reason?: unknown) => {
		if (!controller.signal.aborted) controller.abort(reason)
	}
	const externalAbort = () => abort(signal?.reason)
	signal?.addEventListener('abort', externalAbort, { once: true })
	if (signal?.aborted) externalAbort()
	const assertOpen = () => {
		if (controller.signal.aborted)
			throw new ScriptScopeError('scope_closed', 'Script run is closing or closed')
	}
	const track = (task: Promise<unknown>) => {
		pending.add(task)
		void task.then(
			() => pending.delete(task),
			() => pending.delete(task),
		)
	}
	const runError = (error: unknown, operationSignal?: AbortSignal): ScriptRunError => {
		if (
			(controller.signal.aborted && error === controller.signal.reason) ||
			(operationSignal?.aborted && error === operationSignal.reason)
		)
			return Object.freeze({ code: 'cancelled', message: 'Script operation was cancelled' })
		if (error instanceof ScriptScopeError && error.code === 'scope_closed')
			return Object.freeze({ code: error.code, message: error.message })
		throw error
	}
	const operationError = (error: unknown): ScriptOperationError => {
		if (error instanceof ScriptScopeError && error.code === 'borrowed_generation_conflict')
			return Object.freeze({ code: error.code, message: error.message })
		return runError(error)
	}
	const controlError = (error: unknown): ScriptOperationError | ScriptControlError => {
		if (error instanceof PluginControlError)
			return Object.freeze({ code: error.code, message: error.message })
		return operationError(error)
	}
	const targetError = (error: unknown): ScriptOperationError | ScriptTargetError => {
		if (
			error instanceof ScriptExecutionError &&
			(error.code === 'target_unavailable' || error.code === 'stale_target')
		)
			return Object.freeze({ code: error.code, message: error.message })
		return operationError(error)
	}
	const instanceError = (error: unknown): ScriptInstanceError => {
		if (error instanceof ScriptExecutionError && error.code === 'plugin_not_running')
			return Object.freeze({ code: error.code, message: error.message })
		if (error instanceof PluginControlError) return controlError(error)
		return targetError(error)
	}
	const lifecycleError = (error: unknown): ScriptLifecycleError => {
		if (error instanceof PluginGraphRejectedError)
			return Object.freeze({
				code: error.code,
				message:
					error.cause instanceof CorePluginGraphVerificationError
						? `${error.message}: ${error.cause.message}`
						: error.message,
				state: 'unchanged',
				issues: Object.freeze([...error.issues]),
			})
		if (error instanceof HostStatePersistenceError)
			return Object.freeze({ code: error.code, message: error.message, state: error.state })
		if (
			error instanceof PluginStartUnavailableError ||
			error instanceof PluginRestartUnavailableError
		)
			return Object.freeze({
				code: error.code,
				message: error.message,
				state: error.state,
				address: parsePluginNodeAddress(error.address),
			})
		return targetError(error)
	}
	const logError = (error: unknown): ScriptLogError => {
		if (
			error instanceof ScriptScopeError &&
			(error.code === 'logging_unavailable' || error.code === 'store_unavailable')
		)
			return Object.freeze({ code: error.code, message: error.message })
		return runError(error)
	}
	const run = <T, E, F>(
		work: () => Result<T, E> | Promise<Result<T, E>>,
		failure: (error: unknown) => F,
	): Promise<Result<T, E | F | ScriptRunError>> => {
		try {
			assertOpen()
		} catch (error) {
			return Promise.resolve().then(() => Result.err(failure(error)))
		}
		const task = Promise.resolve()
			.then(() => {
				assertOpen()
				return work()
			})
			.catch((error: unknown) =>
				// Cancellation is identified by the admitted signal's exact reason,
				// before that reason can be mistaken for a domain error class.
				Result.err(
					controller.signal.aborted && error === controller.signal.reason
						? runError(error)
						: failure(error),
				),
			)
		// Track the final Result promise. Expected failures must not become cleanup
		// failures while this run is draining already accepted work.
		track(task)
		return task
	}
	const admission = { signal: controller.signal }
	const mutationOptions = (input?: HostOperationOptions): HostOperationOptions => ({
		...input,
		signal: input?.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal,
	})
	// A coordinator update may already be waiting for an admitted business call.
	// Queueing a Host read from that call would make both operations wait for each other.
	const queued = <T, E, F>(
		work: () => Result<T, E> | Promise<Result<T, E>>,
		failure: (error: unknown) => F,
	): Promise<Result<T, E | F | ScriptRunError>> =>
		run(async () => {
			if (activeCalls > 0)
				throw new ScriptScopeError(
					'borrowed_generation_conflict',
					'Await active business member calls before using queued Host operations',
				)
			queuedCalls++
			try {
				return await work()
			} finally {
				queuedCalls--
			}
		}, failure)
	const overview = (view: HostPluginGraphCommittedView) =>
		hostPluginStatusOverviewFromView({
			catalog: view.catalog,
			state: view.runtimeState.state,
			reconciliation: view.reconciliation,
			lifecycleIssues: readHostPluginLifecycleIssues(ctx),
			sessionIntents: view.sessionIntents,
			desiredControl: view.desiredControl,
			coreNodes: view.coreAdjacency.nodes,
			runningNodeKeys: new Set(view.runningNodes.map(pluginNodeIndexKey)),
			recentUpdate: readHostRecentUpdates(ctx),
		})
	const logOptions = (input?: ScriptLogReadOptions): LogReadOptions | undefined => {
		if (input === undefined) return undefined
		const { filter, ...readOptions } = input
		if (filter === undefined) return readOptions
		const { plugin, ...fields } = filter
		return {
			...readOptions,
			filter: {
				...fields,
				...(plugin === undefined ? {} : { plugin: normalizePluginTarget(plugin).node }),
			},
		}
	}
	const logging = (): RuntimeLogging => {
		if (!ctx.logging)
			throw new ScriptScopeError(
				'logging_unavailable',
				'This Host has no Logging capability; configure runtime.logtape with a history sink to read logs',
			)
		return ctx.require(Logging)
	}
	const assertReadOptions = (input?: Pick<LogReadOptions, 'limit'>) => {
		if (
			input?.limit !== undefined &&
			(!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10000)
		)
			throw new RangeError('Log read limit must be an integer from 1 to 10000')
	}
	// A reference owns only a validated target snapshot. Host state and generation
	// admission remain in the original coordinator for every operation.
	const select = (
		selected: ReturnType<typeof normalizePluginTarget> & { implementation?: PluginConstructor },
	): ScriptPlugin => {
		assertOpen()
		const { node, descriptor, implementation } = selected
		const assertImplementation = (catalog: PluginCatalogSnapshot) => {
			if (!implementation) return
			const entry = pluginCatalogEntry(catalog, node.definition)
			if (!entry)
				throw new ScriptExecutionError(
					'target_unavailable',
					'Plugin definition is absent from the current catalog',
				)
			if (entry.candidate.implementation !== implementation)
				throw new ScriptExecutionError(
					'stale_target',
					'Plugin constructor was replaced; import the current implementation',
				)
		}
		const lifecycle = (action: 'start' | 'stop' | 'restart') =>
			queued(async () => {
				const reason = `script-${action}`
				const report = implementation
					? await coordinator.runExclusive(
							reason,
							async (session) => {
								session.readCommitted(({ catalog }) => assertImplementation(catalog))
								return session.update(pluginLifecycleUpdate(action, node, reason))
							},
							admission,
						)
					: await coordinator[`${action}Node`](node, reason, admission)
				return scriptLifecycleResult(projectPluginApplyReport(ctx, report))
			}, lifecycleError)
		const borrowInstance =
			descriptor || implementation
				? () =>
						queued(() => {
							return coordinator.readCommitted(({ catalog }) => {
								assertOpen()
								assertImplementation(catalog)
								const entry = pluginCatalogEntry(catalog, node.definition)
								if (!entry)
									throw new ScriptExecutionError(
										'target_unavailable',
										'Plugin definition is absent from the current catalog',
									)
								if (descriptor)
									assertPluginControlContract(entry, 'instance', descriptor.contracts.instance)
								const instance = requirePluginService(ctx).getInstance(node)
								if (!instance)
									throw new ScriptExecutionError('plugin_not_running', 'Plugin node is not running')
								if (
									requirePluginGenerationInfo(getPluginGenerationContext(instance))
										.implementation !== entry.candidate.implementation
								)
									throw new ScriptExecutionError(
										'stale_target',
										'Running Plugin generation differs from the committed candidate',
									)
								let view = views.get(instance)
								if (!view) {
									view = createPluginInstanceView(instance, {
										signal: controller.signal,
										assertOpen: () => {
											assertOpen()
											if (queuedCalls > 0)
												throw new ScriptScopeError(
													'borrowed_generation_conflict',
													'Await pending Host operations before accessing Plugin instance members',
												)
										},
										track,
										unwrap,
										begin: () => {
											activeCalls++
										},
										end: () => {
											activeCalls--
										},
									})
									views.set(instance, view)
									originals.set(view, instance)
								}
								// Wrap before returning through any promise: a Plugin's own
								// `then` member is a business member, never an await protocol.
								return Result.ok(view)
							}, admission)
						}, instanceError)
				: undefined
		const config =
			implementation || descriptor?.contracts.config === null
				? undefined
				: Object.freeze({
						get: () =>
							queued(
								async () =>
									scriptConfigResult(
										projectPluginConfigResult(
											ctx,
											await pluginConfigGet(ctx, node, admission, descriptor?.contracts.config),
										),
									),
								controlError,
							),
						validate: (change: HostConfigMutation) =>
							queued(
								async () =>
									scriptConfigResult(
										projectPluginConfigResult(
											ctx,
											await pluginConfigValidate(
												ctx,
												node,
												change,
												admission,
												descriptor?.contracts.config,
											),
										),
									),
								controlError,
							),
						patch: (change: HostConfigMutation, input?: HostOperationOptions) =>
							queued(
								async () =>
									scriptConfigResult(
										projectPluginConfigResult(
											ctx,
											await pluginConfigPatch(
												ctx,
												node,
												change,
												mutationOptions(input),
												descriptor?.contracts.config,
											),
										),
									),
								(error) =>
									input?.signal?.aborted && error === input.signal.reason
										? runError(error, input.signal)
										: controlError(error),
							),
						reset: (paths?: readonly (readonly string[])[], input?: HostOperationOptions) =>
							queued(
								async () =>
									scriptConfigResult(
										projectPluginConfigResult(
											ctx,
											await pluginConfigReset(
												ctx,
												node,
												paths,
												mutationOptions(input),
												descriptor?.contracts.config,
											),
										),
									),
								(error) =>
									input?.signal?.aborted && error === input.signal.reason
										? runError(error, input.signal)
										: controlError(error),
							),
					})
		return Object.freeze({
			address: node,
			fork: (forkId: string) => {
				assertOpen()
				return select({
					node: parsePluginNodeAddress({ definition: node.definition, variant: 'fork', forkId }),
					descriptor,
					implementation,
				})
			},
			status: () =>
				queued(
					() =>
						coordinator.readCommitted((view) => {
							assertImplementation(view.catalog)
							const key = pluginNodeIndexKey(node)
							return Result.ok(
								overview(view).statuses.find(
									(entry) => pluginNodeIndexKey(entry.address) === key,
								) ?? null,
							)
						}, admission),
					targetError,
				),
			start: () => lifecycle('start'),
			stop: () => lifecycle('stop'),
			restart: () => lifecycle('restart'),
			...(borrowInstance ? { instance: borrowInstance } : {}),
			...(config ? { config } : {}),
		})
	}
	const plugin = <const T extends PluginTarget>(target: T): ScriptPlugin<T> => {
		assertOpen()
		// The descriptor's declaration-only marker associates types with this same
		// runtime snapshot; no generic inference is repeated by bound operations.
		return select(normalizePluginTarget(target)) as ScriptPlugin<T>
	}
	const sdk = Object.freeze({
		plugin,
		plugins: Object.freeze({
			list: () =>
				queued(
					() => coordinator.readCommitted((view) => Result.ok(overview(view).statuses), admission),
					operationError,
				),
		}),
		policy: Object.freeze({
			get: () =>
				queued(
					async () => scriptPolicyResult(projectHostPolicyResult(ctx, await policy.get(admission))),
					operationError,
				),
			validate: (values: HostPolicyInput) =>
				queued(
					async () =>
						scriptPolicyResult(
							projectHostPolicyResult(ctx, await policy.validate(values, admission)),
						),
					operationError,
				),
			patch: (values: HostPolicyInput, input?: HostOperationOptions) =>
				queued(
					async () =>
						scriptPolicyResult(
							projectHostPolicyResult(ctx, await policy.patch(values, mutationOptions(input))),
						),
					(error) =>
						input?.signal?.aborted && error === input.signal.reason
							? runError(error, input.signal)
							: operationError(error),
				),
			reset: (keys?: readonly HostPolicyField[], input?: HostOperationOptions) =>
				queued(
					async () =>
						scriptPolicyResult(
							projectHostPolicyResult(ctx, await policy.reset(keys, mutationOptions(input))),
						),
					(error) =>
						input?.signal?.aborted && error === input.signal.reason
							? runError(error, input.signal)
							: operationError(error),
				),
		}),
		updates: Object.freeze({
			latest: () =>
				run(() => Result.ok(readHostRecentUpdates(ctx)?.latestUpdate?.() ?? null), runError),
		}),
		logs: Object.freeze({
			streams: () =>
				run(() => {
					const manager = logging()
					for (const stream of manager.resolved.streams) markLogs(manager, stream.streamId)
					manager.flushStores()
					return Result.ok({
						rootId: manager.resolved.root.id,
						streams: manager.stores.list().map((store) => store.meta()),
					})
				}, logError),
			mark: (streamId = 'default') =>
				run(() => {
					const manager = logging()
					if (
						!manager.stores.get(streamId) &&
						!manager.resolved.streams.some((stream) => stream.streamId === streamId)
					)
						throw new ScriptScopeError(
							'store_unavailable',
							`No history store is configured for stream ${streamId}`,
						)
					return Result.ok(markLogs(manager, streamId))
				}, logError),
			read: (cursor: LogCursor, input?: ScriptLogReadOptions) =>
				run(() => {
					assertReadOptions(input)
					return scriptLogResult(readLogs(logging(), cursor, logOptions(input)))
				}, logError),
			wait: (cursor: LogCursor, input: ScriptLogReadOptions & Readonly<{ timeoutMs: number }>) =>
				run(async () => {
					assertReadOptions(input)
					if (
						!Number.isSafeInteger(input.timeoutMs) ||
						input.timeoutMs < 1 ||
						input.timeoutMs > 300000
					)
						throw new RangeError('Log wait timeoutMs must be an integer from 1 to 300000')
					const manager = logging()
					const timeout = new AbortController()
					const expired = new Error('Log wait deadline reached')
					const timer = setTimeout(() => timeout.abort(expired), input.timeoutMs)
					try {
						return scriptLogResult(
							await waitForLogs(manager, cursor, {
								...logOptions(input),
								signal: AbortSignal.any([controller.signal, timeout.signal]),
							}),
						)
					} catch (error) {
						if (timeout.signal.aborted && !controller.signal.aborted && error === expired)
							return scriptLogResult(readLogs(manager, cursor, logOptions(input)))
						throw error
					} finally {
						clearTimeout(timer)
					}
				}, logError),
		}),
	}) satisfies ScriptSdk
	return Object.freeze({
		sdk,
		assertOpen,
		selectPlugin: (
			node: PluginNodeAddress,
			expectedImplementation: PluginConstructor,
		): ConstructorPlugin => {
			assertOpen()
			const address = parsePluginNodeAddress(node)
			if (
				!pluginDefinitionAddressEqual(
					address.definition,
					expectedImplementation.nodeAddress().definition,
				)
			)
				throw new TypeError('Project constructor and selected Plugin definition must match')
			return select({ node: address, implementation: expectedImplementation }) as ConstructorPlugin
		},
		abort,
		snapshot: () =>
			coordinator.readCommitted((view) => ({
				catalogRevision: view.catalog.revision,
				runtimeStateRevision: view.runtimeState.revision,
				configManagedRevision: (requireConfigService(ctx) as HostConfigStore).managedRevision,
				policyManagedRevision: state.managedRevision(),
			})),
		dispose() {
			if (disposal) return disposal
			abort()
			signal?.removeEventListener('abort', externalAbort)
			disposal = Promise.allSettled(pending).then((results): void => {
				const errors = results.flatMap((result) =>
					result.status === 'rejected' ? [result.reason] : [],
				)
				if (errors.length > 0)
					throw new AggregateError(errors, 'Script operations failed while closing the run')
				return undefined
			})
			return disposal
		},
	})
}

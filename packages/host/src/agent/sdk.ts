import {
	parsePluginNodeAddress,
	pluginNodeIndexKey,
	type PluginNodeAddress,
	type Context,
	type PluginContext,
	type EffectsScope,
	type ServiceDefinition,
	type ServiceRef,
	type RootContext,
} from '@pluxel/core'
import {
	getPluginGenerationContext,
	requirePluginGenerationInfo,
	requirePluginService,
	requireConfigService,
	CorePluginGraphVerificationError,
	readServiceDefinition,
	getServiceDefinitionKey,
	resolveInstalledServiceDefinition,
	assertOwnerInvocationOpen,
} from '@pluxel/core/internal'
import {
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
import { hostPluginStatusFromView } from '../status'
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
import type { HostPolicyPatch, HostPolicyResetTarget } from '../policy'
import type { ScriptPlugin, ScriptSdk } from './sdk-types'
import {
	captureScriptPluginListOptions,
	scriptPluginList,
	type ScriptPluginListOptions,
} from './discovery'
import { normalizePluginTarget } from './control-target'
import { createBorrowedValueView } from './instance-view'
import { createBorrowedVaultView } from './vault-view'
import type { VaultStorageApi } from '@pluxel/core/vault'
import {
	assertPluginControlContract,
	pluginCatalogEntry,
	PluginControlError,
	type PluginCatalogSnapshot,
} from '../catalog'
import { ScriptExecutionError } from './protocol'
import {
	scriptConfigSnapshot,
	scriptPolicySnapshot,
	scriptLifecycleReport,
	scriptLogSnapshot,
	type ScriptErrorDetails,
	type ScriptRunError,
	type ScriptControlError,
	type ScriptTargetError,
	type ScriptInstanceError,
	type ScriptLifecycleError,
	ScriptError,
} from './sdk-outcomes'

export type ScriptRevisions = Readonly<{
	catalogRevision: number
	runtimeStateRevision: number
	configManagedRevision: string
	policyManagedRevision: string
}>

export interface ScriptScope extends AsyncDisposable {
	readonly sdk: ScriptSdk
	/** Guard trusted in-process access at the same run admission boundary. */
	assertOpen(): void
	/** Close admission and signal cooperative cancellation; accepted operations still settle. */
	abort(reason?: unknown): void
	/** Idempotent. Drains tracked calls and releases subscriptions; never closes the Host. */
	dispose(): Promise<void>
	/** Internal execution metadata; remains readable after this scope has closed. */
	snapshot(): Promise<ScriptRevisions>
}

/** Borrow a started Host. No Services, compiler, transport, log backend or new root is installed. */
export function createScriptScope(
	options: Readonly<{
		ctx: RootContext
		signal?: AbortSignal
	}>,
): ScriptScope {
	const { ctx, signal } = options
	const coordinator = requirePluginHostCoordinator(ctx)
	const state = requireHostStateStore(ctx)
	const policy = createHostPolicy(ctx, state)
	const controller = new AbortController()
	const pending = new Set<Promise<unknown>>()
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
			throw new ScriptError({ code: 'scope_closed', message: 'Script run is closing or closed' })
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
		throw error
	}
	const controlError = (error: unknown): ScriptRunError | ScriptControlError => {
		if (error instanceof PluginControlError)
			return Object.freeze({ code: error.code, message: error.message })
		return runError(error)
	}
	const targetError = (error: unknown): ScriptRunError | ScriptTargetError => {
		if (
			error instanceof ScriptExecutionError &&
			(error.code === 'target_unavailable' || error.code === 'stale_target')
		)
			return Object.freeze({ code: error.code, message: error.message })
		return runError(error)
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
	const run = <T>(
		work: () => T | Promise<T>,
		failure: (error: unknown) => ScriptErrorDetails,
		operationSignal?: AbortSignal,
	): Promise<T> => {
		try {
			assertOpen()
		} catch (error) {
			return Promise.reject(error)
		}
		const task = Promise.resolve()
			.then(() => {
				assertOpen()
				return work()
			})
			.catch((error: unknown) => {
				// An admitted signal's exact reason takes precedence over its error class.
				if (
					(controller.signal.aborted && error === controller.signal.reason) ||
					(operationSignal?.aborted && error === operationSignal.reason)
				)
					throw new ScriptError(runError(error, operationSignal))
				if (error instanceof ScriptError) throw error
				// A normalizer rethrows unknown defects instead of relabeling them.
				throw new ScriptError(failure(error), { cause: error })
			})
		// Expected control failures belong to the caller. Draining them must not turn
		// a caught failure into a second cleanup error. Unknown defects still surface.
		track(
			task.catch((error: unknown) => {
				if (!(error instanceof ScriptError)) throw error
			}),
		)
		return task
	}
	const admission = { signal: controller.signal }
	const mutationOptions = (input?: HostOperationOptions): HostOperationOptions => ({
		...input,
		signal: input?.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal,
	})
	// A coordinator update may already be waiting for an admitted business call.
	// Queueing a Host read from that call would make both operations wait for each other.
	const queued = <T>(
		work: () => T | Promise<T>,
		failure: (error: unknown) => ScriptErrorDetails,
		operationSignal?: AbortSignal,
	): Promise<T> =>
		run(
			async () => {
				if (activeCalls > 0)
					throw new ScriptError({
						code: 'borrowed_generation_conflict',
						message: 'Await active business member calls before using queued Host operations',
					})
				queuedCalls++
				try {
					return await work()
				} finally {
					queuedCalls--
				}
			},
			failure,
			operationSignal,
		)
	const statusView = (view: HostPluginGraphCommittedView) => ({
		catalog: view.catalog,
		declaredNodes: view.declaredNodes,
		state: view.runtimeState.state,
		reconciliation: view.reconciliation,
		lifecycleIssues: readHostPluginLifecycleIssues(ctx),
		sessionIntents: view.sessionIntents,
		desiredControl: view.desiredControl,
		coreNodes: view.coreAdjacency.nodes,
		runningNodeKeys: new Set(view.runningNodes.map(pluginNodeIndexKey)),
		recentUpdate: readHostRecentUpdates(ctx),
	})
	const logOptions = (input?: LogReadOptions): LogReadOptions | undefined => {
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
		const installed = ctx.logging
		if (installed === undefined)
			throw new ScriptError({
				code: 'logging_unavailable',
				message:
					'This Host has no logging runtime. Configure coreConfig.logtape with a history sink to read logs.',
			})
		return installed
	}
	const assertReadOptions = (input?: Pick<LogReadOptions, 'limit'>) => {
		if (
			input?.limit !== undefined &&
			(!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10000)
		)
			throw new RangeError('Log read limit must be an integer from 1 to 10000')
	}
	const ownedEffects: EffectsScope[] = []
	const contextValues = new WeakMap<Context, WeakMap<object, object>>()
	const contexts = new WeakMap<Context, Context>()
	const assertContextOpen = (owner: Context) => {
		assertOpen()
		if (queuedCalls > 0)
			throw new ScriptError({
				code: 'borrowed_generation_conflict',
				message: 'Await pending Host operations before accessing Context capabilities',
			})
		assertOwnerInvocationOpen(owner)
	}
	const projectContext = (owner: Context, value: unknown): unknown => {
		if (value === owner) return contextView(owner)
		if (value === owner.root) return contextView(owner.root)
		if (value !== undefined && (value === owner.parent || value === owner.caller))
			return contextView(value as Context)
		return value
	}
	const borrow = <T>(owner: Context, value: T): T => {
		if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
		let owned = contextValues.get(owner)
		if (!owned) {
			owned = new WeakMap()
			contextValues.set(owner, owned)
		}
		const cached = owned.get(value)
		if (cached) return cached as T
		const borrowed = createBorrowedValueView(value, owner, {
			assertOpen: () => assertContextOpen(owner),
			track,
			unwrap,
			project: (result) => projectContext(owner, result),
			begin: () => {
				activeCalls++
			},
			end: () => {
				activeCalls--
			},
		})
		owned.set(value, borrowed)
		originals.set(borrowed, value)
		return borrowed as T
	}
	const contextView = <T extends Context>(owner: T): T => {
		const cached = contexts.get(owner)
		if (cached) return cached as T
		let effects: EffectsScope | undefined
		let vault: VaultStorageApi | undefined
		const scriptEffects = () => {
			if (!effects) {
				effects = owner.effects.scope({ tag: 'Script' })
				ownedEffects.push(effects)
			}
			return effects
		}
		const view = {
			get name() {
				assertContextOpen(owner)
				return owner.name
			},
			get root() {
				assertContextOpen(owner)
				return contextView(owner.root)
			},
			get parent() {
				assertContextOpen(owner)
				return owner.parent && contextView(owner.parent)
			},
			get caller() {
				assertContextOpen(owner)
				return owner.caller && contextView(owner.caller)
			},
			get pluginInfo() {
				assertContextOpen(owner)
				return owner.pluginInfo
			},
			get logger() {
				assertContextOpen(owner)
				return borrow(owner, owner.logger)
			},
			get events() {
				assertContextOpen(owner)
				return borrow(owner, owner.events)
			},
			get effects() {
				assertContextOpen(owner)
				return borrow(owner, scriptEffects())
			},
			[Symbol.toStringTag]: 'PluxelContext',
			service: (target: ServiceDefinition<unknown> | ServiceRef<unknown>): unknown => {
				assertContextOpen(owner)
				const expected = readServiceDefinition(target)
				const installed = resolveInstalledServiceDefinition(owner, getServiceDefinitionKey(target))
				if (installed && expected.contract) {
					const actual = readServiceDefinition(installed).contract
					if (!actual)
						throw new ScriptError({
							code: 'control_material_unavailable',
							message: 'The installed service has no accepted control contract',
						})
					if (actual !== expected.contract)
						throw new ScriptError({
							code: 'control_contract_mismatch',
							message: 'The service control contract does not match the installed declaration',
						})
				}
				return borrow(owner, owner.service(target as ServiceDefinition<unknown>))
			},
		}

		// Match Core's non-enumerable Context fields; inspecting a view must not
		// eagerly read borrowed capabilities or traverse stale generation getters.
		for (const key of Reflect.ownKeys(view)) Object.defineProperty(view, key, { enumerable: false })
		if (Object.is(owner, owner.root)) {
			Object.defineProperty(view, 'logging', {
				get: () => {
					assertContextOpen(owner)
					return borrow(owner, owner.root.logging)
				},
			})
		} else if (owner.pluginInfo) {
			const plugin = owner as unknown as PluginContext
			let wretch: PluginContext['wretch'] | undefined
			const fetch: PluginContext['fetch'] = (input, init) => {
				let task: Promise<Response>
				try {
					assertContextOpen(owner)
					const callerSignal =
						init?.signal === undefined && input instanceof Request ? input.signal : init?.signal
					const requestSignal = callerSignal
						? AbortSignal.any([controller.signal, callerSignal])
						: controller.signal
					task = plugin.fetch(input, { ...init, signal: requestSignal })
				} catch (error) {
					return Promise.reject(error)
				}
				activeCalls++
				track(
					task.then(
						(): undefined => {
							activeCalls--
							return undefined
						},
						(error: unknown): undefined => {
							activeCalls--
							if (!controller.signal.aborted || error !== controller.signal.reason) throw error
							return undefined
						},
					),
				)
				return task
			}
			Object.defineProperties(view, {
				fetch: {
					get: () => {
						assertContextOpen(owner)
						return fetch
					},
				},
				wretch: {
					get: () => {
						assertContextOpen(owner)
						return (wretch ??= plugin.wretch.fetchPolyfill(fetch))
					},
				},
				fs: {
					get: () => {
						assertContextOpen(owner)
						return borrow(owner, plugin.fs)
					},
				},
				vault: {
					get: () => {
						assertContextOpen(owner)
						return (vault ??= createBorrowedVaultView(plugin.vault, {
							borrow: (value) => borrow(owner, value),
							defer: (cleanup) => scriptEffects().defer(cleanup, { tag: 'VaultWatch' }),
						}))
					},
				},
				tinybase: {
					get: () => {
						assertContextOpen(owner)
						return borrow(owner, plugin.tinybase)
					},
				},
			})
		}
		Object.freeze(view)
		contexts.set(owner, view as unknown as Context)
		originals.set(view, owner)
		return view as unknown as T
	}

	// A reference owns only a validated target snapshot. Host state and generation
	// admission remain in the original coordinator for every operation.
	const select = (selected: ReturnType<typeof normalizePluginTarget>): unknown => {
		assertOpen()
		const { address, node, descriptor, implementation } = selected
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
				return scriptLifecycleReport(projectPluginApplyReport(ctx, report))
			}, lifecycleError)
		const borrowInstance =
			descriptor || implementation
				? () =>
						queued(() => {
							return coordinator.readCommittedState(({ catalog }) => {
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
								const view = borrow(getPluginGenerationContext(instance), instance)
								// Wrap before returning through any promise: a Plugin's own
								// `then` member is a business member, never an await protocol.
								return Object.freeze({ instance: view })
							}, admission)
						}, instanceError)
				: undefined
		const config = Object.freeze({
			get: () =>
				queued(
					async () =>
						scriptConfigSnapshot(
							projectPluginConfigResult(
								ctx,
								await pluginConfigGet(
									ctx,
									node,
									admission,
									implementation ?? descriptor?.contracts.config,
								),
							),
						),
					controlError,
				),
			validate: (change: HostConfigMutation) =>
				queued(
					async () =>
						scriptConfigSnapshot(
							projectPluginConfigResult(
								ctx,
								await pluginConfigValidate(
									ctx,
									node,
									change,
									admission,
									implementation ?? descriptor?.contracts.config,
								),
							),
						),
					controlError,
				),
			patch: (change: HostConfigMutation, input?: HostOperationOptions) =>
				queued(
					async () =>
						scriptConfigSnapshot(
							projectPluginConfigResult(
								ctx,
								await pluginConfigPatch(
									ctx,
									node,
									change,
									mutationOptions(input),
									implementation ?? descriptor?.contracts.config,
								),
							),
						),
					controlError,
					input?.signal,
				),
			reset: (paths?: readonly (readonly string[])[], input?: HostOperationOptions) =>
				queued(
					async () =>
						scriptConfigSnapshot(
							projectPluginConfigResult(
								ctx,
								await pluginConfigReset(
									ctx,
									node,
									paths,
									mutationOptions(input),
									implementation ?? descriptor?.contracts.config,
								),
							),
						),
					controlError,
					input?.signal,
				),
		})
		return Object.freeze({
			address,
			status: () =>
				queued(
					() =>
						coordinator.readCommitted((view) => {
							assertImplementation(view.catalog)
							return hostPluginStatusFromView(statusView(view), node)
						}, admission),
					targetError,
				),
			context: () =>
				queued(
					() =>
						coordinator.readCommittedState(({ catalog }) => {
							assertImplementation(catalog)
							const entry = pluginCatalogEntry(catalog, node.definition)
							if (!entry)
								throw new ScriptExecutionError(
									'target_unavailable',
									'Plugin definition is absent from the current catalog',
								)
							const instance = requirePluginService(ctx).getInstance(node)
							if (!instance)
								throw new ScriptExecutionError('plugin_not_running', 'Plugin node is not running')
							const owner = getPluginGenerationContext(instance)
							if (
								requirePluginGenerationInfo(owner).implementation !== entry.candidate.implementation
							)
								throw new ScriptExecutionError(
									'stale_target',
									'Running generation differs from the committed candidate',
								)
							return contextView(owner as unknown as PluginContext)
						}, admission),
					instanceError,
				),
			start: () => lifecycle('start'),
			stop: () => lifecycle('stop'),
			restart: () => lifecycle('restart'),
			instance:
				borrowInstance ??
				(() =>
					queued(() => {
						throw new PluginControlError(
							'control_evidence_missing',
							'Instance access requires an original address from a generated provider or current Plugin class',
						)
					}, instanceError)),
			config,
		})
	}
	const plugin = <const T extends PluginNodeAddress>(target: T): ScriptPlugin<T> => {
		assertOpen()
		// The descriptor's declaration-only marker associates types with this same
		// runtime snapshot; no generic inference is repeated by bound operations.
		return select(normalizePluginTarget(target)) as ScriptPlugin<T>
	}
	const sdk = Object.freeze({
		get ctx() {
			assertOpen()
			return contextView(ctx)
		},
		plugin,
		plugins: Object.freeze({
			list: (input?: ScriptPluginListOptions) => {
				let query: ReturnType<typeof captureScriptPluginListOptions> | undefined
				let queryError: unknown
				try {
					query = captureScriptPluginListOptions(input)
				} catch (error) {
					queryError = error
				}
				return queued(() => {
					// Keep invalid-input rejection in the same tracked operation and
					// preserve closed-scope admission without retaining caller objects.
					if (!query) throw queryError
					const captured = query
					return coordinator.readCommitted(
						(view) =>
							scriptPluginList(
								coordinator,
								{
									...statusView(view),
									runtimeStateRevision: view.runtimeState.revision,
									appliedNodes: view.applied.nodes,
								},
								captured,
							),
						admission,
					)
				}, runError)
			},
		}),
		policy: Object.freeze({
			get: () =>
				queued(
					async () =>
						scriptPolicySnapshot(projectHostPolicyResult(ctx, await policy.get(admission))),
					runError,
				),
			validate: (values: HostPolicyPatch) =>
				queued(
					async () =>
						scriptPolicySnapshot(
							projectHostPolicyResult(ctx, await policy.validate(values, admission)),
						),
					runError,
				),
			patch: (values: HostPolicyPatch, input?: HostOperationOptions) =>
				queued(
					async () =>
						scriptPolicySnapshot(
							projectHostPolicyResult(ctx, await policy.patch(values, mutationOptions(input))),
						),
					runError,
					input?.signal,
				),
			reset: (keys?: readonly HostPolicyResetTarget[], input?: HostOperationOptions) =>
				queued(
					async () =>
						scriptPolicySnapshot(
							projectHostPolicyResult(ctx, await policy.reset(keys, mutationOptions(input))),
						),
					runError,
					input?.signal,
				),
		}),
		updates: Object.freeze({
			latest: () => run(() => readHostRecentUpdates(ctx)?.latestUpdate?.() ?? null, runError),
		}),
		logs: Object.freeze({
			streams: () =>
				run(() => {
					const manager = logging()
					for (const stream of manager.resolved.streams) markLogs(manager, stream.streamId)
					manager.flushStores()
					return {
						rootId: manager.resolved.root.id,
						streams: manager.stores.list().map((store) => store.meta()),
					}
				}, runError),
			mark: (streamId = 'default') =>
				run(() => {
					const manager = logging()
					if (
						!manager.stores.get(streamId) &&
						!manager.resolved.streams.some((stream) => stream.streamId === streamId)
					)
						throw new ScriptError({
							code: 'store_unavailable',
							message: `No history store is configured for stream ${streamId}`,
						})
					return markLogs(manager, streamId)
				}, runError),
			read: (cursor: LogCursor, input?: LogReadOptions) =>
				run(() => {
					assertReadOptions(input)
					return scriptLogSnapshot(readLogs(logging(), cursor, logOptions(input)))
				}, runError),
			wait: (cursor: LogCursor, input: LogReadOptions & Readonly<{ timeoutMs: number }>) =>
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
						return scriptLogSnapshot(
							await waitForLogs(manager, cursor, {
								...logOptions(input),
								signal: AbortSignal.any([controller.signal, timeout.signal]),
							}),
						)
					} catch (error) {
						if (timeout.signal.aborted && !controller.signal.aborted && error === expired)
							return scriptLogSnapshot(readLogs(manager, cursor, logOptions(input)))
						throw error
					} finally {
						clearTimeout(timer)
					}
				}, runError),
		}),
	}) satisfies ScriptSdk
	const dispose = () => {
		if (disposal) return disposal
		abort()
		signal?.removeEventListener('abort', externalAbort)
		disposal = Promise.allSettled(pending).then(async (results): Promise<void> => {
			// Accepted acquisitions and transactions must settle before their resources close.
			const cleanup = await Promise.allSettled(ownedEffects.map((effects) => effects.dispose()))
			const errors = [...results, ...cleanup].flatMap((result) =>
				result.status === 'rejected' ? [result.reason] : [],
			)
			if (errors.length > 0)
				throw new AggregateError(errors, 'Script operations failed while closing the run')
			return undefined
		})
		return disposal
	}

	return Object.freeze({
		sdk,
		assertOpen,
		abort,
		snapshot: () =>
			coordinator.readCommittedState((view): ScriptRevisions => ({
				catalogRevision: view.catalog.revision,
				runtimeStateRevision: view.runtimeState.revision,
				configManagedRevision: (requireConfigService(ctx) as HostConfigStore).managedRevision,
				policyManagedRevision: state.managedRevision(),
			})),
		dispose,
		[Symbol.asyncDispose]: dispose,
	})
}

import { parsePluginNodeAddress, pluginNodeIndexKey, type RootContext } from '@pluxel/core'
import {
	getPluginGenerationContext,
	requirePluginGenerationInfo,
	requirePluginService,
	requireConfigService,
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
import { readHostPluginStatusOverview } from '../status'
import { readHostRecentUpdates } from '../recent-update'
import type { HostOperationOptions } from '../coordinator'
import type { HostConfigStore } from '../config-store'
import type { HostPolicyField, HostPolicyInput } from '../policy'
import type { ScriptPlugin, ScriptSdk } from './sdk-types'
import type { PluginTarget, ScriptLogReadOptions } from './control'
import { normalizePluginTarget } from './control-target'
import { createPluginInstanceView } from './instance-view'
import { assertPluginControlContract, pluginCatalogEntry } from '../catalog'
import { ScriptExecutionError } from './protocol'

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
	const run = <T>(work: () => T | Promise<T>): Promise<T> => {
		try {
			assertOpen()
		} catch (error) {
			return Promise.reject(error)
		}
		const task = Promise.resolve().then(() => {
			assertOpen()
			return work()
		})
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
	const queued = <T>(work: () => T | Promise<T>): Promise<T> =>
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
	const select = (selected: ReturnType<typeof normalizePluginTarget>): ScriptPlugin => {
		assertOpen()
		const { node, descriptor } = selected
		const lifecycle = (action: 'start' | 'stop' | 'restart') =>
			queued(async () =>
				projectPluginApplyReport(
					ctx,
					await coordinator[`${action}Node`](node, `script-${action}`, admission),
				),
			)
		const borrowInstance = descriptor
			? () =>
					queued(() => {
						return coordinator.readCommitted(({ catalog }) => {
							assertOpen()
							const entry = pluginCatalogEntry(catalog, node.definition)
							if (!entry)
								throw new ScriptExecutionError(
									'target_unavailable',
									'Plugin definition is absent from the current catalog',
								)
							assertPluginControlContract(entry, 'instance', descriptor.contracts.instance)
							const instance = requirePluginService(ctx).getInstance(node)
							if (!instance)
								throw new ScriptExecutionError('plugin_not_running', 'Plugin node is not running')
							if (
								requirePluginGenerationInfo(getPluginGenerationContext(instance)).implementation !==
								entry.candidate.implementation
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
							return Object.freeze({ instance: view })
						}, admission)
					})
			: undefined
		const config =
			descriptor?.contracts.config === null
				? undefined
				: Object.freeze({
						get: () =>
							queued(async () =>
								projectPluginConfigResult(
									ctx,
									await pluginConfigGet(ctx, node, admission, descriptor?.contracts.config),
								),
							),
						validate: (change: HostConfigMutation) =>
							queued(async () =>
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
						patch: (change: HostConfigMutation, input?: HostOperationOptions) =>
							queued(async () =>
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
						reset: (paths?: readonly (readonly string[])[], input?: HostOperationOptions) =>
							queued(async () =>
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
					})
		return Object.freeze({
			address: node,
			fork: (forkId: string) => {
				assertOpen()
				return select({
					node: parsePluginNodeAddress({ definition: node.definition, variant: 'fork', forkId }),
					descriptor,
				})
			},
			status: () =>
				queued(async () => {
					const key = pluginNodeIndexKey(node)
					const overview = await readHostPluginStatusOverview(ctx)
					return (
						overview.statuses.find((entry) => pluginNodeIndexKey(entry.address) === key) ?? null
					)
				}),
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
				queued(async () => {
					const overview = await readHostPluginStatusOverview(ctx)
					return overview.statuses
				}),
		}),
		policy: Object.freeze({
			get: () => queued(async () => projectHostPolicyResult(ctx, await policy.get(admission))),
			validate: (values: HostPolicyInput) =>
				queued(async () => projectHostPolicyResult(ctx, await policy.validate(values, admission))),
			patch: (values: HostPolicyInput, input?: HostOperationOptions) =>
				queued(async () =>
					projectHostPolicyResult(ctx, await policy.patch(values, mutationOptions(input))),
				),
			reset: (keys?: readonly HostPolicyField[], input?: HostOperationOptions) =>
				queued(async () =>
					projectHostPolicyResult(ctx, await policy.reset(keys, mutationOptions(input))),
				),
		}),
		updates: Object.freeze({
			latest: () => run(() => readHostRecentUpdates(ctx)?.latestUpdate?.() ?? null),
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
				}),
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
					return markLogs(manager, streamId)
				}),
			read: (cursor: LogCursor, input?: ScriptLogReadOptions) =>
				run(() => {
					assertReadOptions(input)
					return readLogs(logging(), cursor, logOptions(input))
				}),
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
						return await waitForLogs(manager, cursor, {
							...logOptions(input),
							signal: AbortSignal.any([controller.signal, timeout.signal]),
						})
					} catch (error) {
						if (timeout.signal.aborted && !controller.signal.aborted && error === expired)
							return readLogs(manager, cursor, logOptions(input))
						throw error
					} finally {
						clearTimeout(timer)
					}
				}),
		}),
	}) satisfies ScriptSdk
	return Object.freeze({
		sdk,
		assertOpen,
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

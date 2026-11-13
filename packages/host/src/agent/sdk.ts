import {
	parsePluginNodeAddress,
	pluginNodeIndexKey,
	type RootContext,
	type PluginNodeAddress,
} from '@pluxel/core'
import { requireConfigService } from '@pluxel/core/internal'
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
import type { ScriptSdk } from './sdk-types'

export class ScriptScopeError extends Error {
	constructor(
		readonly code: 'scope_closed' | 'logging_unavailable' | 'store_unavailable',
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
		pending.add(task)
		void task.then(
			() => pending.delete(task),
			() => pending.delete(task),
		)
		return task
	}
	const admission = { signal: controller.signal }
	const mutationOptions = (input?: HostOperationOptions): HostOperationOptions => ({
		...input,
		signal: input?.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal,
	})
	const lifecycle = (node: PluginNodeAddress, action: 'start' | 'stop' | 'restart') =>
		run(async () =>
			projectPluginApplyReport(
				ctx,
				await coordinator[`${action}Node`](
					parsePluginNodeAddress(node),
					`script-${action}`,
					admission,
				),
			),
		)
	const logging = (): RuntimeLogging => {
		if (!ctx.logging)
			throw new ScriptScopeError(
				'logging_unavailable',
				'This Host has no Logging capability; configure runtime.logtape with a history sink to read logs',
			)
		return ctx.require(Logging)
	}
	const assertReadOptions = (input?: LogReadOptions) => {
		if (
			input?.limit !== undefined &&
			(!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10000)
		)
			throw new RangeError('Log read limit must be an integer from 1 to 10000')
	}
	const sdk: ScriptSdk = Object.freeze({
		plugins: Object.freeze({
			list: () =>
				run(async () => {
					const overview = await readHostPluginStatusOverview(ctx)
					return overview.statuses
				}),
			status: (node: PluginNodeAddress) =>
				run(async () => {
					const key = pluginNodeIndexKey(parsePluginNodeAddress(node))
					const overview = await readHostPluginStatusOverview(ctx)
					return (
						overview.statuses.find((entry) => pluginNodeIndexKey(entry.address) === key) ?? null
					)
				}),
			start: (node: PluginNodeAddress) => lifecycle(node, 'start'),
			stop: (node: PluginNodeAddress) => lifecycle(node, 'stop'),
			restart: (node: PluginNodeAddress) => lifecycle(node, 'restart'),
		}),
		config: Object.freeze({
			get: (node: PluginNodeAddress) =>
				run(async () =>
					projectPluginConfigResult(ctx, await pluginConfigGet(ctx, node, admission)),
				),
			validate: (node: PluginNodeAddress, change: HostConfigMutation) =>
				run(async () =>
					projectPluginConfigResult(ctx, await pluginConfigValidate(ctx, node, change, admission)),
				),
			patch: (node: PluginNodeAddress, change: HostConfigMutation, input?: HostOperationOptions) =>
				run(async () =>
					projectPluginConfigResult(
						ctx,
						await pluginConfigPatch(ctx, node, change, mutationOptions(input)),
					),
				),
			reset: (
				node: PluginNodeAddress,
				paths?: readonly (readonly string[])[],
				input?: HostOperationOptions,
			) =>
				run(async () =>
					projectPluginConfigResult(
						ctx,
						await pluginConfigReset(ctx, node, paths, mutationOptions(input)),
					),
				),
		}),
		policy: Object.freeze({
			get: () => run(async () => projectHostPolicyResult(ctx, await policy.get(admission))),
			validate: (values: HostPolicyInput) =>
				run(async () => projectHostPolicyResult(ctx, await policy.validate(values, admission))),
			patch: (values: HostPolicyInput, input?: HostOperationOptions) =>
				run(async () =>
					projectHostPolicyResult(ctx, await policy.patch(values, mutationOptions(input))),
				),
			reset: (keys?: readonly HostPolicyField[], input?: HostOperationOptions) =>
				run(async () =>
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
			read: (cursor: LogCursor, input?: LogReadOptions) =>
				run(() => {
					assertReadOptions(input)
					return readLogs(logging(), cursor, input)
				}),
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
						return await waitForLogs(manager, cursor, {
							...input,
							signal: AbortSignal.any([controller.signal, timeout.signal]),
						})
					} catch (error) {
						if (timeout.signal.aborted && !controller.signal.aborted && error === expired)
							return readLogs(manager, cursor, input)
						throw error
					} finally {
						clearTimeout(timer)
					}
				}),
		}),
	})
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

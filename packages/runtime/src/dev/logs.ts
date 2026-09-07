import type { RootContext, PluginNodeAddress } from '@pluxel/core'
import { getContextRuntimeLogging } from '../logger/logging'
import { matchesLogFilter, type LogStreamMeta } from '../logger/protocol'
import {
	DevConsoleError,
	type DevConsole,
	type DevPluginTarget,
	type DevLogCursor,
	type DevLogReadOptions,
	type DevLogReadResult,
	type DevLogWaitResult,
} from './contracts'
import type { DevScope } from './scope'

function limit(value = 200): number {
	if (!Number.isInteger(value) || value < 1 || value > 2000)
		throw new RangeError('Log limit must be an integer between 1 and 2000')
	return value
}

export function createDevLogs(
	ctx: RootContext,
	scope: DevScope,
	resolveTarget: (target: DevPluginTarget) => PluginNodeAddress,
): DevConsole['logs'] {
	const resolve = (streamId = 'default') => {
		const logging = getContextRuntimeLogging(ctx)
		if (!logging || !Object.values(logging.resolved.sinks).some((sink) => sink.kind === 'store'))
			throw new DevConsoleError('logs_unavailable', 'The current host has no configured log store')
		logging.flushStores()
		const configured = Object.values(logging.resolved.sinks).find(
			(sink): sink is import('../logger/logging').RuntimeStoreSinkInput =>
				sink.kind === 'store' &&
				(('streamId' in sink ? sink.streamId : undefined) ?? 'default') === streamId,
		)
		const store =
			logging.stores.get(streamId) ??
			(configured
				? logging.stores.getOrCreate(streamId, { windowLines: configured.windowLines })
				: undefined)
		if (!store)
			throw new DevConsoleError('logs_unavailable', `Log stream ${streamId} is unavailable`)
		const cursor = (meta: LogStreamMeta, nextSeq = meta.nextSeq): DevLogCursor => ({
			rootId: logging.resolved.root.id,
			bootId: meta.bootId,
			streamId: meta.streamId,
			epoch: meta.epoch,
			nextSeq,
		})
		return { store, cursor }
	}
	const filterOf = (options: {
		target?: DevPluginTarget
		filter?: import('../logger/protocol').LogFilter
	}) => {
		if (options.target !== undefined && options.filter?.plugin !== undefined)
			throw new TypeError('Use target or filter.plugin, not both')
		return {
			...options.filter,
			...(options.target === undefined ? {} : { plugin: resolveTarget(options.target) }),
		}
	}
	const read = (options: DevLogReadOptions): DevLogReadResult => {
		const { store, cursor } = resolve(options.cursor.streamId)
		const meta = store.meta()
		const current = cursor(meta)
		if (current.rootId !== options.cursor.rootId || current.bootId !== options.cursor.bootId)
			return { ok: false, code: 'root_changed', cursor: current }
		// Scan an explicitly bounded page before filtering; callers continue with hasMore.
		const result = store.range({
			epoch: options.cursor.epoch,
			fromSeq: options.cursor.nextSeq,
			limit: limit(options.limit),
		})
		if (result.ok === false) return { ...result, cursor: cursor(meta, meta.headSeq) }
		const filter = filterOf(options)
		return {
			ok: true,
			lines: result.lines.filter((line) => matchesLogFilter(line, filter)),
			cursor: cursor(meta, result.nextSeq),
			hasMore: BigInt(result.nextSeq) < BigInt(meta.nextSeq),
		}
	}
	return Object.freeze({
		mark: (options = {}) =>
			scope.run(() => {
				const { store, cursor } = resolve(options.streamId)
				return cursor(store.meta())
			}),
		tail: (options = {}) =>
			scope.run(() => {
				const { store, cursor } = resolve(options.streamId)
				const meta = store.meta()
				const filter = filterOf(options)
				return {
					meta,
					lines: store
						.tailWindow(limit(options.limit))
						.filter((line) => matchesLogFilter(line, filter)),
					cursor: cursor(meta),
				}
			}),
		read: (options) => scope.run(() => read(options)),
		wait: (options) =>
			scope.run(async (): Promise<DevLogWaitResult> => {
				const timeoutMs = options.timeoutMs ?? 5000
				if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000)
					throw new RangeError('Log wait timeout must be between 0 and 30000 milliseconds')
				const signal = options.signal
					? AbortSignal.any([scope.controller.signal, options.signal])
					: scope.controller.signal
				signal.throwIfAborted()
				const { store } = resolve(options.cursor.streamId)
				return await new Promise<DevLogWaitResult>((accept, reject) => {
					let done = false
					let current = options.cursor
					let unsubscribe = () => {}
					let timer: ReturnType<typeof setTimeout> | undefined
					const finish = (result?: DevLogWaitResult, error?: unknown) => {
						if (done) return
						done = true
						unsubscribe()
						if (timer !== undefined) clearTimeout(timer)
						signal.removeEventListener('abort', abort)
						if (error !== undefined) reject(error)
						else accept(result!)
					}
					const abort = () =>
						finish(undefined, signal.reason ?? new DOMException('Aborted', 'AbortError'))
					const check = (timedOut = false) => {
						if (done) return
						try {
							const result = read({ ...options, cursor: current })
							if (result.ok === false) return finish({ reason: 'reset', result })
							current = result.cursor
							if (result.lines.length > 0) return finish({ reason: 'available', result })
							if (result.hasMore) return finish({ reason: 'more', result })
							if (timedOut) finish({ reason: 'timeout', result })
						} catch (error) {
							finish(undefined, error)
						}
					}
					// Subscribe before rechecking so append/reset cannot be lost between read and registration.
					unsubscribe = store.subscribe(() => check())
					signal.addEventListener('abort', abort, { once: true })
					timer = setTimeout(() => check(true), timeoutMs)
					if (signal.aborted) abort()
					else check(timeoutMs === 0)
				})
			}),
	})
}

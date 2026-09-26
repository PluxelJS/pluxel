import type { RuntimeLogging, RuntimeStoreSinkInput } from './logging'
import type { LogFilter, LogRangeErr, RuntimeLogLine } from './protocol'

/** JSON cursor bound to one Host and one physical stream incarnation. */
export type LogCursor = Readonly<{
	rootId: string
	streamId: string
	bootId: string
	epoch: number
	nextSeq: string
}>

export type LogReadResult =
	| { ok: true; cursor: LogCursor; lines: RuntimeLogLine[] }
	| LogRangeErr
	| { ok: false; code: 'root_mismatch' | 'stream_replaced' | 'store_unavailable' }

export type LogReadOptions = {
	/** Maximum matching records returned; defaults to 100. Must be a positive integer. */
	limit?: number
	filter?: LogFilter
}

/** Flush and mark the end, materializing an empty configured stream when needed. Does not add a sink. */
export function markLogs(logging: RuntimeLogging, streamId = 'default'): LogCursor {
	logging.flushStores()
	let store = logging.stores.get(streamId)
	if (!store) {
		const sink = Object.values(logging.resolved.sinks).find(
			(candidate): candidate is RuntimeStoreSinkInput =>
				candidate.kind === 'store' &&
				((candidate as RuntimeStoreSinkInput).streamId ?? 'default') === streamId,
		)
		if (sink) store = logging.stores.getOrCreate(streamId, { windowLines: sink.windowLines })
	}
	if (!store) throw new Error(`Log store is not installed: ${streamId}`)
	const { bootId, epoch, nextSeq } = store.meta()
	return { rootId: logging.resolved.root.id, streamId, bootId, epoch, nextSeq }
}

/** Read after a mark without silently skipping replacement, reset or retention gaps. */
export function readLogs(
	logging: RuntimeLogging,
	cursor: LogCursor,
	options: LogReadOptions = {},
): LogReadResult {
	const limit = options.limit ?? 100
	if (!Number.isSafeInteger(limit) || limit <= 0)
		throw new RangeError('Log read limit must be a positive safe integer')
	if (logging.resolved.root.id !== cursor.rootId) return { ok: false, code: 'root_mismatch' }
	logging.flushStores()
	const store = logging.stores.get(cursor.streamId)
	if (!store) return { ok: false, code: 'store_unavailable' }
	if (store.bootId !== cursor.bootId) return { ok: false, code: 'stream_replaced' }
	const result = store.range({
		epoch: cursor.epoch,
		fromSeq: cursor.nextSeq,
		limit,
		filter: options.filter,
	})
	return result.ok === true
		? { ok: true, cursor: { ...cursor, nextSeq: result.nextSeq }, lines: result.lines }
		: result
}

/**
 * Wait for the first matching batch or cursor discontinuity. The required signal bounds
 * the wait; abort rejects with its reason and releases the subscription. No logging
 * configuration or producer is owned/cancelled by this operation.
 */
export async function waitForLogs(
	logging: RuntimeLogging,
	cursor: LogCursor,
	options: LogReadOptions & { signal: AbortSignal },
): Promise<LogReadResult> {
	options.signal.throwIfAborted()
	const initial = readLogs(logging, cursor, options)
	if (!initial.ok || initial.lines.length > 0) return initial
	const store = logging.stores.get(cursor.streamId)!
	let next = initial.cursor
	return new Promise<LogReadResult>((resolve, reject) => {
		let settled = false
		let queued = false
		const cleanup = () => {
			settled = true
			unsubscribe()
			options.signal.removeEventListener('abort', abort)
		}
		const abort = () => {
			if (settled) return
			cleanup()
			reject(options.signal.reason)
		}
		const check = () => {
			queued = false
			if (settled) return
			try {
				const result = readLogs(logging, next, options)
				if (!result.ok || result.lines.length > 0) {
					cleanup()
					resolve(result)
				} else next = result.cursor
			} catch (error) {
				cleanup()
				reject(error)
			}
		}
		// Flush can emit synchronously. Schedule reads outside the append callback.
		const unsubscribe = store.subscribe(() => {
			if (queued || settled) return
			queued = true
			queueMicrotask(check)
		})
		options.signal.addEventListener('abort', abort, { once: true })
		if (options.signal.aborted) abort()
		else check()
	})
}

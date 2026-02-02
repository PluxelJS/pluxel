import { matchesFilter, logStore, type LogFilter, type UiLogRecord } from '../../logger/logStore'

export type LogsLatestInput = {
	filter?: LogFilter
	afterId?: number
	limit?: number
}

export type LogsLatestOutput = {
	records: UiLogRecord[]
	lastId: number
	bootId: string
}

export type LogsWaitInput = LogsLatestInput & {
	/**
	 * Wait for at least one matching record if none are currently available.
	 *
	 * Defaults to 30_000.
	 */
	timeoutMs?: number
	signal?: AbortSignal
}

/**
 * Return a snapshot of UI logs with the same semantics as `/api/logs/latest`.
 *
 * Notes:
 * - `afterId` is forward-only (increasing id cursor).
 * - For "latest" queries, we avoid allocating/filtering the full buffer by using a ring buffer.
 */
export function logsLatest(input: LogsLatestInput = {}): LogsLatestOutput {
	const filter = input.filter ?? {}
	const afterId = typeof input.afterId === 'number' && Number.isFinite(input.afterId) ? input.afterId : undefined
	const limitRaw = typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : 200
	const limit = Math.min(Math.max(1, Math.floor(limitRaw)), logStore.capacity)

	let records: UiLogRecord[] = []
	if (afterId !== undefined) {
		const snap = logStore.snapshot(logStore.capacity, afterId)
		for (let i = 0; i < snap.length; i++) {
			const l = snap[i]!
			if (!matchesFilter(l, filter)) continue
			records.push(l)
			if (records.length >= limit) break
		}
	} else {
		const snap = logStore.snapshot(logStore.capacity)
		const buf = new Array<UiLogRecord>(limit)
		let start = 0
		let len = 0
		for (let i = 0; i < snap.length; i++) {
			const l = snap[i]!
			if (!matchesFilter(l, filter)) continue
			if (len < limit) {
				buf[(start + len) % limit] = l
				len++
			} else {
				buf[start] = l
				start = (start + 1) % limit
			}
		}
		if (len < limit) {
			records = buf.slice(0, len)
		} else {
			records = buf.slice(start).concat(buf.slice(0, start))
		}
	}

	return { records, lastId: logStore.lastId, bootId: logStore.bootId }
}

/**
 * Wait for logs matching filter/cursor, using the in-memory logStore as the source of truth.
 *
 * This is MCP-friendly: clients can repeatedly call this tool to simulate SSE streaming,
 * without requiring server->client notifications support.
 */
export async function logsWaitFor(input: LogsWaitInput = {}): Promise<LogsLatestOutput> {
	const first = logsLatest(input)
	if (first.records.length) return first

	const timeoutMs =
		typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
			? Math.max(0, Math.floor(input.timeoutMs))
			: 30_000
	if (timeoutMs === 0) return first

	if (input.signal?.aborted) {
		throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
	}

	return await new Promise<LogsLatestOutput>((resolve, reject) => {
		let done = false
		let timeout: NodeJS.Timeout | undefined
		let unsubscribe: (() => void) | undefined

		const cleanup = () => {
			if (timeout) clearTimeout(timeout)
			timeout = undefined
			unsubscribe?.()
			unsubscribe = undefined
			if (typeof input.signal?.removeEventListener === 'function' && onAbort) {
				input.signal.removeEventListener('abort', onAbort)
			}
		}

		const finish = (fn: () => LogsLatestOutput) => {
			if (done) return
			done = true
			cleanup()
			try {
				resolve(fn())
			} catch (error) {
				reject(error)
			}
		}

		const onAbort =
			input.signal && typeof input.signal === 'object'
				? () => {
						if (done) return
						done = true
						cleanup()
						reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
					}
				: null

		if (onAbort) input.signal!.addEventListener('abort', onAbort, { once: true })

		timeout = setTimeout(() => finish(() => logsLatest(input)), timeoutMs)

		unsubscribe = logStore.subscribe((record) => {
			if (done) return
			if (input.afterId !== undefined && record.id <= input.afterId) return
			if (!matchesFilter(record, input.filter ?? {})) return
			finish(() => logsLatest(input))
		})
	})
}

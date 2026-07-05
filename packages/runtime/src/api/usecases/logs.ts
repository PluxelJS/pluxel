import {
	compileLogFilter,
	matchesLogFilterCompiled,
	type LogFilter,
	type LogRangeResult,
	type LogStreamMeta,
	type RuntimeLogLine,
} from '../../logger/protocol'
import { runtimeLogStores, runtimeLogs } from '../../logger/store'

export type LogsMetaInput = {
	streamId?: string
}

export type LogsMetaOutput = LogStreamMeta

export type LogsRangeInput = {
	streamId?: string
	epoch: number
	fromSeq: string
	limit?: number
	filter?: LogFilter
}

export type LogsRangeOutput = LogRangeResult

export type LogsLatestInput = {
	streamId?: string
	filter?: LogFilter
	/** Last seen seq; returns records strictly after it. */
	afterSeq?: string
	limit?: number
}

export type LogsLatestOutput = {
	meta: LogStreamMeta
	lines: RuntimeLogLine[]
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

function toStreamId(input?: string): string {
	return input?.trim() ? input : 'default'
}

type ResolvedLogStream = {
	streamId: string
	store: typeof runtimeLogs
	derivedFilter?: LogFilter
	virtual: boolean
}

function resolveStream(input?: string): ResolvedLogStream {
	const requested = toStreamId(input)
	if (requested === 'default') return { streamId: 'default', store: runtimeLogs, virtual: false }
	const existing = runtimeLogStores.get(requested)
	if (existing) return { streamId: requested, store: existing, virtual: false }
	if (requested.startsWith('plugin:')) {
		const pluginId = requested.slice('plugin:'.length)
		if (!pluginId) throw new Error('Invalid plugin stream id')
		return { streamId: requested, store: runtimeLogs, virtual: true, derivedFilter: { pluginId } }
	}
	if (requested.startsWith('context:')) {
		const context = requested.slice('context:'.length)
		if (!context) throw new Error('Invalid context stream id')
		return { streamId: requested, store: runtimeLogs, virtual: true, derivedFilter: { context } }
	}
	throw new Error(`Log stream not found: ${requested}`)
}

function parseSeq(raw: string | undefined): bigint | null {
	if (!raw) return null
	if (!/^\d+$/.test(raw)) return null
	try {
		return BigInt(raw)
	} catch {
		return null
	}
}

function seqToString(n: bigint): string {
	return n.toString(10)
}

function assignDefined<T extends object>(out: T, k: keyof T, v: unknown) {
	if (v !== undefined && v !== null) (out as any)[k] = v
}

function mergeFilters(a: LogFilter | undefined, b: LogFilter | undefined): LogFilter | null {
	if (!a) return b ?? {}
	if (!b) return a
	if (a.pluginId && b.pluginId && a.pluginId !== b.pluginId) return null
	if (a.context && b.context && a.context !== b.context) return null
	if (a.displayName && b.displayName && a.displayName !== b.displayName) return null
	if (a.category && b.category && a.category !== b.category) return null
	const out: LogFilter = { ...a }
	assignDefined(out, 'pluginId', b.pluginId)
	assignDefined(out, 'context', b.context)
	assignDefined(out, 'displayName', b.displayName)
	assignDefined(out, 'category', b.category)
	return out
}

function mapLinesStreamId(lines: RuntimeLogLine[], streamId: string): RuntimeLogLine[] {
	return lines.map((l) => ({ ...l, streamId }))
}

export function logsMeta(input: LogsMetaInput = {}): LogsMetaOutput {
	const resolved = resolveStream(input.streamId)
	return { ...resolved.store.meta(), streamId: resolved.streamId }
}

export function logsRange(input: LogsRangeInput): LogsRangeOutput {
	const resolved = resolveStream(input.streamId)
	const filter = mergeFilters(input.filter, resolved.derivedFilter)
	if (filter === null)
		return {
			ok: false,
			code: 'invalid',
			message: 'Conflicting filters',
			streamId: resolved.streamId,
		}
	const out = resolved.store.range({
		epoch: input.epoch,
		fromSeq: input.fromSeq,
		limit: input.limit ?? 2000,
		filter,
	})
	if (!out.ok) return resolved.virtual ? { ...out, streamId: resolved.streamId } : out
	if (!resolved.virtual) return out
	return {
		...out,
		streamId: resolved.streamId,
		lines: mapLinesStreamId(out.lines, resolved.streamId),
	}
}

/**
 * Return a "tail" snapshot for UI/agents.
 *
 * Notes:
 * - This uses a local tail window + filtering for speed and bounded allocation.
 * - For strict cursor semantics, use `logsRange()` (epoch/fromSeq/nextSeq).
 */
export function logsLatest(input: LogsLatestInput = {}): LogsLatestOutput {
	const resolved = resolveStream(input.streamId)
	const meta = { ...resolved.store.meta(), streamId: resolved.streamId }
	const limitRaw =
		typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : 200
	const limit = Math.min(Math.max(1, Math.floor(limitRaw)), meta.retention.windowLines)

	const filter = mergeFilters(input.filter ?? {}, resolved.derivedFilter)
	if (filter === null) return { meta, lines: [] }
	const compiledFilter = compileLogFilter(filter)
	const hasFilter = compiledFilter.hasFilter

	// Start from afterSeq if provided, otherwise take a tail window.
	const after = parseSeq(input.afterSeq)
	let window = resolved.store.tailWindow(Math.min(meta.count, Math.max(limit * 20, limit)))
	if (after !== null) {
		window = window.filter((l) => {
			try {
				return BigInt(l.seq) > after
			} catch {
				return true
			}
		})
	}

	if (hasFilter) window = window.filter((l) => matchesLogFilterCompiled(l, compiledFilter))

	// Keep the most recent `limit` matching.
	if (window.length > limit) window = window.slice(window.length - limit)

	return { meta, lines: resolved.virtual ? mapLinesStreamId(window, resolved.streamId) : window }
}

/**
 * Wait for logs matching filter/cursor.
 *
 * Transport-neutral polling helper: clients can call it in a loop to simulate SSE tailing.
 */
export async function logsWaitFor(input: LogsWaitInput = {}): Promise<LogsLatestOutput> {
	const first = logsLatest(input)
	if (first.lines.length > 0) return first

	const timeoutMs =
		typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
			? Math.max(0, Math.floor(input.timeoutMs))
			: 30_000
	if (timeoutMs === 0) return first

	if (input.signal?.aborted) {
		throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
	}

	const resolved = resolveStream(input.streamId)
	const store = resolved.store
	const after = parseSeq(input.afterSeq)
	const filter = mergeFilters(input.filter ?? {}, resolved.derivedFilter)
	if (filter === null) return first
	const compiledFilter = compileLogFilter(filter)
	const hasFilter = compiledFilter.hasFilter

	return await new Promise<LogsLatestOutput>((resolve, reject) => {
		let done = false
		let timeout: ReturnType<typeof setTimeout> | undefined
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

		const finish = () => {
			if (done) return
			done = true
			cleanup()
			try {
				resolve(logsLatest(input))
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
		timeout = setTimeout(finish, timeoutMs)

		unsubscribe = store.subscribe((ev) => {
			if (done) return
			if (ev.type === 'reset') {
				finish()
				return
			}
			if (ev.type !== 'append') return
			const lines = Array.isArray(ev.lines) ? ev.lines : []
			if (lines.length === 0) return

			for (let i = 0; i < lines.length; i++) {
				const l = lines[i]!
				if (after !== null) {
					try {
						if (BigInt(l.seq) <= after) continue
					} catch {
						// ignore parse errors
					}
				}
				if (hasFilter && !matchesLogFilterCompiled(l, compiledFilter)) continue
				finish()
				return
			}
		})
	})
}

export function addSeq(raw: string, delta: bigint): string {
	const n = parseSeq(raw)
	if (n === null) return raw
	return seqToString(n + delta)
}

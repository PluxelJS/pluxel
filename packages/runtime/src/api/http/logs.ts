import { parseEpoch, parseFromSeq, parseLogFilter, resolveFromSeq } from '../../logger/filters'
import {
	compileLogFilter,
	matchesLogFilterCompiled,
	type LogFilter,
	type LogSseAppend,
	type LogSseGap,
	type LogSseReset,
	type RuntimeLogLine,
} from '../../logger/protocol'
import {
	type RuntimeLogStoreAppend,
	type RuntimeLogStoreReset,
	runtimeLogStores,
	runtimeLogs,
} from '../../logger/store'
import { type AnyElysiaApp } from '../../services/http/elysia'
import { createSseResponse } from '../../services/http/sse'
import { HMR_LOG_STREAMS_BASE } from '../../web/paths'
import { logFollowQuery, logRangeQuery, logStreamParams } from './models'

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
	const raw = process.env[name]
	if (!raw) return fallback
	const n = Number(raw)
	if (!Number.isFinite(n)) return fallback
	const v = Math.floor(n)
	return Math.min(max, Math.max(min, v))
}

type ResolvedLogStream = {
	/** Stream id requested by the client (may be virtual). */
	streamId: string
	/** Underlying store. */
	store: typeof runtimeLogs
	/** Extra filter implied by the stream id (virtual streams only). */
	derivedFilter?: LogFilter
	/** Whether this stream is virtual (backed by `default` store). */
	virtual: boolean
}

function resolveStream(streamIdRaw: string | undefined): ResolvedLogStream | null {
	const requested = (streamIdRaw ?? '').trim() || 'default'
	if (requested === 'default') return { streamId: 'default', store: runtimeLogs, virtual: false }

	const existing = runtimeLogStores.get(requested)
	if (existing) return { streamId: requested, store: existing, virtual: false }

	if (requested.startsWith('plugin:')) {
		const pluginId = requested.slice('plugin:'.length)
		if (!pluginId) return null
		return { streamId: requested, store: runtimeLogs, virtual: true, derivedFilter: { pluginId } }
	}
	if (requested.startsWith('context:')) {
		const context = requested.slice('context:'.length)
		if (!context) return null
		return { streamId: requested, store: runtimeLogs, virtual: true, derivedFilter: { context } }
	}

	return null
}

function parseLimit(search: URLSearchParams, fallback: number, max: number) {
	const raw = search.get('limit')
	if (!raw) return fallback
	const n = Number(raw)
	if (!Number.isFinite(n)) return fallback
	return Math.min(max, Math.max(1, Math.floor(n)))
}

function parseSeq(raw: string): bigint | null {
	try {
		if (!raw || !/^\d+$/.test(raw)) return null
		return BigInt(raw)
	} catch {
		return null
	}
}

function subOne(raw: string): string | null {
	const n = parseSeq(raw)
	if (n === null) return null
	if (n <= 0n) return '0'
	return (n - 1n).toString(10)
}

function buildResolvedStreamMeta(resolved: ResolvedLogStream) {
	return { ...resolved.store.meta(), streamId: resolved.streamId }
}

function resolveRequestedStream(raw: string | undefined): ResolvedLogStream | undefined {
	const requested = decodeURIComponent(raw ?? '')
	return resolveStream(requested) ?? undefined
}

function withResolvedStream(
	streamId: string | undefined,
	onMissing: () => unknown,
	handler: (resolved: ResolvedLogStream) => unknown,
) {
	const resolved = resolveRequestedStream(streamId)
	if (!resolved) return onMissing()
	return handler(resolved)
}

function mergeResolvedFilter(url: URL, resolved: ResolvedLogStream): LogFilter | null {
	return mergeFilters(parseLogFilter(url.searchParams), resolved.derivedFilter)
}

export const logRoutes = (app: AnyElysiaApp) =>
	app.group(HMR_LOG_STREAMS_BASE, (streams) =>
		streams
			.get('', () => ({ streams: runtimeLogStores.list().map((store) => store.meta()) }))
			.get(
				'/:streamId/meta',
				(c) =>
					withResolvedStream(
						c.params.streamId,
						() => c.status(404, 'Stream not found'),
						(resolved) => buildResolvedStreamMeta(resolved),
					),
				{
					params: logStreamParams,
				},
			)
			.get(
				'/:streamId/stats',
				(c) =>
					withResolvedStream(
						c.params.streamId,
						() => c.status(404, 'Stream not found'),
						(resolved) => ({
							meta: buildResolvedStreamMeta(resolved),
							subscribers: resolved.store.subscriberCount,
						}),
					),
				{
					params: logStreamParams,
				},
			)
			.get(
				'/:streamId/range',
				(c) =>
					withResolvedStream(
						c.params.streamId,
						() => c.status(404, 'Stream not found'),
						(resolved) => {
							const store = resolved.store
							const url = new URL(c.request.url)
							const filter = mergeResolvedFilter(url, resolved)
							if (filter === null) {
								return c.status(416, { ok: false, code: 'invalid', message: 'Conflicting filters' })
							}

							const out = store.range({
								epoch: parseEpoch(url.searchParams) ?? store.meta().epoch,
								fromSeq: parseFromSeq(url.searchParams) ?? store.meta().headSeq,
								limit: parseLimit(url.searchParams, 2000, 20_000),
								filter,
							})
							if (out.ok === true) {
								if (resolved.virtual) {
									return {
										...out,
										streamId: resolved.streamId,
										lines: out.lines.map((line) => ({ ...line, streamId: resolved.streamId })),
									}
								}
								return out
							}

							const errOut = out as Extract<typeof out, { ok: false }>
							const err =
								resolved.virtual && (errOut as unknown as { streamId?: unknown }).streamId
									? { ...errOut, streamId: resolved.streamId }
									: errOut
							if (errOut.code === 'epoch_mismatch') return c.status(409, err)
							if (errOut.code === 'from_too_old') return c.status(410, err)
							return c.status(416, err)
						},
					),
				{
					params: logStreamParams,
					query: logRangeQuery,
				},
			)
			.get(
				'/:streamId/follow',
				(c) => {
					const resolved = resolveRequestedStream(c.params.streamId)
					if (!resolved) return c.status(404, 'Stream not found')

					const store = resolved.store
					const outStreamId = resolved.streamId
					const url = new URL(c.request.url)
					const filter = mergeResolvedFilter(url, resolved)
					if (filter === null) return c.status(416, 'Conflicting filters')

					const compiledFilter = compileLogFilter(filter)
					const hasFilter = compiledFilter.hasFilter
					const meta = store.meta()
					const wantEpoch = parseEpoch(url.searchParams)
					const resolvedFrom = resolveFromSeq(
						url.searchParams,
						c.request.headers.get('Last-Event-ID'),
					)

					// Default follow behavior is "tail -f": start at nextSeq unless caller provides a cursor.
					let cursor = resolvedFrom ?? meta.nextSeq
					// If epoch mismatches, force a reset + tail-follow.
					const epoch = meta.epoch
					const epochMismatch = typeof wantEpoch === 'number' && wantEpoch !== epoch
					if (epochMismatch) cursor = meta.nextSeq

					const maxPendingLines = readIntEnv(
						'PLUXEL_LOGS_FOLLOW_MAX_PENDING_LINES',
						5000,
						10,
						1_000_000,
					)
					const maxPendingBytes = readIntEnv(
						'PLUXEL_LOGS_FOLLOW_MAX_PENDING_BYTES',
						2_000_000,
						1024,
						200_000_000,
					)
					const catchupLimit = readIntEnv('PLUXEL_LOGS_FOLLOW_CATCHUP_LIMIT', 5000, 10, 50_000)
					const maxBufferedAppendLines = readIntEnv(
						'PLUXEL_LOGS_FOLLOW_MAX_BUFFERED_APPEND_LINES',
						20_000,
						100,
						2_000_000,
					)
					const pingIntervalMs = readIntEnv(
						'PLUXEL_LOGS_FOLLOW_PING_INTERVAL_MS',
						15_000,
						1000,
						300_000,
					)

					return createSseResponse(
						c.request,
						async (sse) => {
							let aborted = false
							sse.onAbort(() => {
								aborted = true
							})

							const sendReset = async () => {
								const nextMeta = store.meta()
								const payload: LogSseReset = {
									type: 'reset',
									streamId: outStreamId,
									bootId: nextMeta.bootId,
									epoch: nextMeta.epoch,
									headSeq: nextMeta.headSeq,
									tailSeq: nextMeta.tailSeq,
									nextSeq: nextMeta.nextSeq,
									count: nextMeta.count,
									retention: nextMeta.retention,
								}
								await sse.writeSSE({
									event: 'reset',
									retry: 3000,
									data: JSON.stringify(payload),
								})
								return nextMeta
							}

							type PendingMsg =
								| { kind: 'reset'; bytes: number; json: string }
								| { kind: 'gap'; bytes: number; json: string }
								| { kind: 'comment'; bytes: number; text: string }
								| {
										kind: 'append'
										bytes: number
										json: string
										lastId: string | null
										linesCount: number
										nextSeq: string
								  }

							const pending: PendingMsg[] = []
							let pendingStart = 0
							let pendingLines = 0
							let pendingBytes = 0
							let draining = false
							let cursorN = parseSeq(cursor) ?? parseSeq(meta.nextSeq) ?? 1n
							let lastPingAt = Date.now()

							const clearPending = () => {
								pending.length = 0
								pendingStart = 0
								pendingLines = 0
								pendingBytes = 0
							}

							const pushMsg = (message: PendingMsg) => {
								pending.push(message)
								pendingBytes += message.bytes
								if (message.kind === 'append') pendingLines += message.linesCount
							}

							const overflowToGap = () => {
								const nextMeta = store.meta()
								const from = cursorN.toString(10)
								const to = nextMeta.tailSeq
								clearPending()
								// Move cursor to tail+1 so new appends can resume.
								cursorN = (parseSeq(to) ?? 0n) + 1n
								const payload: LogSseGap = {
									type: 'gap',
									streamId: outStreamId,
									epoch: nextMeta.epoch,
									missingFrom: from,
									missingTo: to,
								}
								const json = JSON.stringify(payload)
								pushMsg({ kind: 'gap', json, bytes: json.length })
							}

							const enqueuePing = () => {
								const now = Date.now()
								if (now - lastPingAt < pingIntervalMs) return
								lastPingAt = now
								const text = ': ping\n\n'
								// Do not count as "lines" (backpressure is line-based + byte-based).
								if (pendingBytes + text.length > maxPendingBytes) return
								pushMsg({ kind: 'comment', text, bytes: text.length })
							}

							const enqueueResetMsg = async () => {
								const nextMeta = await sendReset()
								cursorN = parseSeq(nextMeta.nextSeq) ?? cursorN
								clearPending()
							}

							const enqueueAppendLines = (
								fromSeq: string,
								nextSeq: string,
								lines: RuntimeLogLine[],
								opts: { alreadyFiltered?: boolean } = {},
							) => {
								if (lines.length === 0) return
								const fromN = parseSeq(fromSeq)
								const nextN = parseSeq(nextSeq)
								if (fromN === null || nextN === null) return
								if (nextN <= cursorN) return

								let sliced = lines
								let effectiveFromN = fromN
								if (fromN < cursorN) {
									const start = cursorN - fromN
									const startIdx = Number(start)
									if (!Number.isFinite(startIdx) || startIdx <= 0) return
									sliced = lines.slice(startIdx)
									effectiveFromN = cursorN
								}
								if (sliced.length === 0) return

								let filtered = sliced
								if (hasFilter && opts.alreadyFiltered !== true) {
									filtered = sliced.filter((line) => matchesLogFilterCompiled(line, compiledFilter))
								}
								if (filtered.length === 0) return

								if (pendingLines + filtered.length > maxPendingLines) {
									overflowToGap()
									return
								}

								const nextMeta = store.meta()
								const payload: LogSseAppend = {
									type: 'append',
									streamId: outStreamId,
									epoch: nextMeta.epoch,
									fromSeq: effectiveFromN.toString(10),
									nextSeq,
									lines: resolved.virtual
										? filtered.map((line) => ({ ...line, streamId: outStreamId }))
										: filtered,
								}
								const json = JSON.stringify(payload)
								const bytes = json.length
								if (pendingBytes + bytes > maxPendingBytes) {
									overflowToGap()
									return
								}
								const last = subOne(nextSeq)
								pushMsg({
									kind: 'append',
									json,
									bytes,
									lastId: last,
									linesCount: filtered.length,
									nextSeq,
								})
							}

							const drain = async () => {
								if (draining) return
								draining = true
								try {
									while (!aborted) {
										const next = pending[pendingStart]
										if (!next) break
										pendingStart++

										if (pendingStart > 2048) {
											pending.splice(0, pendingStart)
											pendingStart = 0
										}

										pendingBytes = Math.max(0, pendingBytes - next.bytes)

										if (next.kind === 'reset') {
											await sse.writeSSE({ event: 'reset', retry: 3000, data: next.json })
											continue
										}

										if (next.kind === 'gap') {
											await sse.writeSSE({ event: 'gap', data: next.json })
											continue
										}

										if (next.kind === 'comment') {
											await sse.write(next.text)
											continue
										}

										pendingLines = Math.max(0, pendingLines - next.linesCount)
										await sse.writeSSE({
											event: 'append',
											...(next.lastId ? { id: next.lastId } : {}),
											data: next.json,
										})
										const nextCursor = parseSeq(next.nextSeq)
										if (nextCursor !== null) cursorN = nextCursor
									}
								} finally {
									draining = false
								}
							}

							// During connect/catch-up, buffer appends to avoid advancing the cursor out-of-order.
							// The catch-up loop replays authoritative history from the store; buffered appends
							// only cover boundary races at the end of catch-up.
							let bufferingAppends = true
							let bufferedAppends: RuntimeLogStoreAppend[] = []
							let bufferedAppendLines = 0

							const clearBufferedAppends = () => {
								bufferedAppends = []
								bufferedAppendLines = 0
							}

							const onStoreEvent = (event: RuntimeLogStoreAppend | RuntimeLogStoreReset) => {
								if (aborted) return
								if (event.type === 'reset') {
									// Reset invalidates cursors and filters. Send reset immediately and clear buffers.
									const payload: LogSseReset = {
										type: 'reset',
										streamId: outStreamId,
										bootId: event.bootId,
										epoch: event.epoch,
										headSeq: event.headSeq,
										tailSeq: event.tailSeq,
										nextSeq: event.nextSeq,
										count: event.count,
										retention: event.retention,
									}
									const json = JSON.stringify(payload)
									clearPending()
									clearBufferedAppends()
									pushMsg({ kind: 'reset', json, bytes: json.length })
									const next = parseSeq(event.nextSeq)
									if (next !== null) cursorN = next
									void drain()
									return
								}

								if (bufferingAppends) {
									bufferedAppends.push(event)
									bufferedAppendLines += event.lines.length
									// Safety: if we buffer too much while catching up, degrade to a gap.
									if (bufferedAppendLines > maxBufferedAppendLines) {
										clearBufferedAppends()
										overflowToGap()
										void drain()
									}
									return
								}

								enqueueAppendLines(event.fromSeq, event.nextSeq, event.lines)
								void drain()
							}

							const unsubscribe = store.subscribe(onStoreEvent)
							try {
								// Always send a reset snapshot first (clients can treat it as "ready + meta").
								const currentMeta = await sendReset()
								if (epochMismatch) {
									// On mismatch, do not attempt replay. Client should call /range if it needs history.
									cursorN = parseSeq(currentMeta.nextSeq) ?? cursorN
								} else {
									cursorN = parseSeq(cursor) ?? cursorN
								}

								// Catch up from cursor (bounded, resumable).
								while (!aborted && !epochMismatch) {
									const nextMeta = store.meta()
									const nextN = parseSeq(nextMeta.nextSeq) ?? cursorN
									if (cursorN >= nextN) break
									const out = store.range({
										epoch: nextMeta.epoch,
										fromSeq: cursorN.toString(10),
										limit: catchupLimit,
										filter,
									})
									if (!out.ok) {
										await enqueueResetMsg()
										break
									}
									// Range output is already filtered server-side (when filter is provided).
									enqueueAppendLines(cursorN.toString(10), out.nextSeq, out.lines, {
										alreadyFiltered: hasFilter,
									})
									const nextCursor = parseSeq(out.nextSeq)
									if (nextCursor !== null) cursorN = nextCursor
									await drain()
									// If we had to overflow to a gap, stop catch-up: client must resync via /range.
									if (pending.some((message) => message.kind === 'gap')) break
								}

								// Switch to live processing, then flush buffered boundary appends.
								bufferingAppends = false
								for (let i = 0; i < bufferedAppends.length; i++) {
									const event = bufferedAppends[i]!
									enqueueAppendLines(event.fromSeq, event.nextSeq, event.lines)
									// If we had to overflow to a gap, stop and let the client resync.
									if (pending.some((message) => message.kind === 'gap')) break
								}
								clearBufferedAppends()
								await drain()

								while (!aborted) {
									enqueuePing()
									void drain()
									await sse.sleep(1000)
								}
							} finally {
								unsubscribe()
							}
						},
						{ 'X-Accel-Buffering': 'no' },
					)
				},
				{
					params: logStreamParams,
					query: logFollowQuery,
				},
			),
	)

function assignDefined<T extends object>(out: T, k: keyof T, v: unknown) {
	if (v !== undefined && v !== null) (out as any)[k] = v
}

function mergeFilters(a: LogFilter | undefined, b: LogFilter | undefined): LogFilter | null {
	if (!a) return b ?? {}
	if (!b) return a
	// Conflicts only matter for the same key (virtual streams imply pluginId/context).
	if (a.pluginId && b.pluginId && a.pluginId !== b.pluginId) return null
	if (a.context && b.context && a.context !== b.context) return null
	if (a.displayName && b.displayName && a.displayName !== b.displayName) return null
	if (a.category && b.category && a.category !== b.category) return null

	const out: LogFilter = { ...a }
	assignDefined(out, 'name', b.name)
	assignDefined(out, 'pluginId', b.pluginId)
	assignDefined(out, 'context', b.context)
	assignDefined(out, 'displayName', b.displayName)
	assignDefined(out, 'category', b.category)
	return out
}

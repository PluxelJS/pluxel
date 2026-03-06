import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

import { parseEpoch, parseFromSeq, parseLogFilter, resolveFromSeq } from '../../logger/filters'
import type {
	LogFilter,
	LogSseAppend,
	LogSseGap,
	LogSseReset,
	RuntimeLogLine,
} from '../../logger/protocol'
import { compileLogFilter, matchesLogFilterCompiled } from '../../logger/protocol'
import {
	type RuntimeLogStoreAppend,
	type RuntimeLogStoreReset,
	runtimeLogStores,
	runtimeLogs,
} from '../../logger/store'

export const logsApp = new Hono()

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

logsApp.get('/v1/streams/:streamId/meta', (c) => {
	const streamId = decodeURIComponent(c.req.param('streamId'))
	const resolved = resolveStream(streamId)
	if (!resolved) return c.text('Stream not found', 404)
	return c.json({ ...resolved.store.meta(), streamId: resolved.streamId })
})

logsApp.get('/v1/streams', (c) => {
	const out = runtimeLogStores.list().map((s) => s.meta())
	return c.json({ streams: out })
})

logsApp.get('/v1/streams/:streamId/stats', (c) => {
	const streamId = decodeURIComponent(c.req.param('streamId'))
	const resolved = resolveStream(streamId)
	if (!resolved) return c.text('Stream not found', 404)
	return c.json({
		meta: { ...resolved.store.meta(), streamId: resolved.streamId },
		subscribers: resolved.store.subscriberCount,
	})
})

logsApp.get('/v1/streams/:streamId/range', (c) => {
	const streamId = decodeURIComponent(c.req.param('streamId'))
	const resolved = resolveStream(streamId)
	if (!resolved) return c.text('Stream not found', 404)
	const store = resolved.store

	const url = new URL(c.req.url)
	const filterRaw = parseLogFilter(url.searchParams)
	const filter = mergeFilters(filterRaw, resolved.derivedFilter)
	if (filter === null)
		return c.json({ ok: false, code: 'invalid', message: 'Conflicting filters' }, 416)
	const epoch = parseEpoch(url.searchParams) ?? store.meta().epoch
	const fromSeq = parseFromSeq(url.searchParams) ?? store.meta().headSeq
	const limit = parseLimit(url.searchParams, 2000, 20_000)

	const out = store.range({ epoch, fromSeq, limit, filter })
	if (out.ok === true) {
		if (resolved.virtual) {
			return c.json({
				...out,
				streamId: resolved.streamId,
				lines: out.lines.map((l) => ({ ...l, streamId: resolved.streamId })),
			})
		}
		return c.json(out)
	}

	const errOut = out as Extract<typeof out, { ok: false }>
	const err =
		resolved.virtual && (errOut as unknown as { streamId?: unknown }).streamId
			? { ...errOut, streamId: resolved.streamId }
			: errOut
	if (errOut.code === 'epoch_mismatch') return c.json(err, 409)
	if (errOut.code === 'from_too_old') return c.json(err, 410)
	return c.json(err, 416)
})

logsApp.get('/v1/streams/:streamId/follow', (c) => {
	const streamId = decodeURIComponent(c.req.param('streamId'))
	const resolved = resolveStream(streamId)
	if (!resolved) return c.text('Stream not found', 404)
	const store = resolved.store
	const outStreamId = resolved.streamId

	// Avoid proxy buffering (e.g. nginx) which can delay SSE delivery.
	c.header('X-Accel-Buffering', 'no')

	const url = new URL(c.req.url)
	const filterRaw = parseLogFilter(url.searchParams)
	const filter = mergeFilters(filterRaw, resolved.derivedFilter)
	if (filter === null) return c.text('Conflicting filters', 416)
	const compiledFilter = compileLogFilter(filter)
	const hasFilter = compiledFilter.hasFilter

	const meta = store.meta()
	const wantEpoch = parseEpoch(url.searchParams)
	const resolvedFrom = resolveFromSeq(url.searchParams, c.req.header('Last-Event-ID'))

	// Default follow behavior is "tail -f": start at nextSeq unless caller provides a cursor.
	let cursor = resolvedFrom ?? meta.nextSeq
	// If epoch mismatches, force a reset + tail-follow.
	const epoch = meta.epoch
	const epochMismatch = typeof wantEpoch === 'number' && wantEpoch !== epoch
	if (epochMismatch) cursor = meta.nextSeq

	const maxPendingLines = readIntEnv('PLUXEL_LOGS_FOLLOW_MAX_PENDING_LINES', 5000, 10, 1_000_000)
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
	const pingIntervalMs = readIntEnv('PLUXEL_LOGS_FOLLOW_PING_INTERVAL_MS', 15_000, 1000, 300_000)

	return streamSSE(c, async (sse) => {
		let aborted = false
		sse.onAbort(() => {
			aborted = true
		})

		const sendReset = async () => {
			const m = store.meta()
			const payload: LogSseReset = {
				type: 'reset',
				streamId: outStreamId,
				bootId: m.bootId,
				epoch: m.epoch,
				headSeq: m.headSeq,
				tailSeq: m.tailSeq,
				nextSeq: m.nextSeq,
				count: m.count,
				retention: m.retention,
			}
			await sse.writeSSE({
				event: 'reset',
				retry: 3000,
				data: JSON.stringify(payload),
			})
			return m
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

		const pushMsg = (m: PendingMsg) => {
			pending.push(m)
			pendingBytes += m.bytes
			if (m.kind === 'append') pendingLines += m.linesCount
		}

		const overflowToGap = () => {
			const m = store.meta()
			const from = cursorN.toString(10)
			const to = m.tailSeq
			clearPending()
			// Move cursor to tail+1 so new appends can resume.
			cursorN = (parseSeq(to) ?? 0n) + 1n
			const payload: LogSseGap = {
				type: 'gap',
				streamId: outStreamId,
				epoch: m.epoch,
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
			const m = await sendReset()
			cursorN = parseSeq(m.nextSeq) ?? cursorN
			clearPending()
		}

		const enqueueAppendLines = (
			fromSeq: string,
			nextSeq: string,
			lines: RuntimeLogLine[],
			opts: { alreadyFiltered?: boolean } = {},
		) => {
			if (!lines.length) return
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
			if (!sliced.length) return

			let filtered = sliced
			if (hasFilter && opts.alreadyFiltered !== true)
				filtered = sliced.filter((l) => matchesLogFilterCompiled(l, compiledFilter))
			if (!filtered.length) return

			if (pendingLines + filtered.length > maxPendingLines) {
				overflowToGap()
				return
			}

			const m = store.meta()
			const payload: LogSseAppend = {
				type: 'append',
				streamId: outStreamId,
				epoch: m.epoch,
				fromSeq: effectiveFromN.toString(10),
				nextSeq,
				lines: resolved.virtual ? filtered.map((l) => ({ ...l, streamId: outStreamId })) : filtered,
			}
			const json = JSON.stringify(payload)
			const bytes = json.length
			if (pendingBytes + bytes > maxPendingBytes) {
				overflowToGap()
				return
			}
			const last = subOne(nextSeq)
			pushMsg({ kind: 'append', json, bytes, lastId: last, linesCount: filtered.length, nextSeq })
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

		const onStoreEvent = (ev: RuntimeLogStoreAppend | RuntimeLogStoreReset) => {
			if (aborted) return
			if (ev.type === 'reset') {
				// Reset invalidates cursors and filters. Send reset immediately and clear buffers.
				const payload: LogSseReset = {
					type: 'reset',
					streamId: outStreamId,
					bootId: ev.bootId,
					epoch: ev.epoch,
					headSeq: ev.headSeq,
					tailSeq: ev.tailSeq,
					nextSeq: ev.nextSeq,
					count: ev.count,
					retention: ev.retention,
				}
				const json = JSON.stringify(payload)
				clearPending()
				clearBufferedAppends()
				pushMsg({ kind: 'reset', json, bytes: json.length })
				const next = parseSeq(ev.nextSeq)
				if (next !== null) cursorN = next
				void drain()
				return
			}

			if (bufferingAppends) {
				bufferedAppends.push(ev)
				bufferedAppendLines += ev.lines.length
				// Safety: if we buffer too much while catching up, degrade to a gap.
				if (bufferedAppendLines > maxBufferedAppendLines) {
					clearBufferedAppends()
					overflowToGap()
					void drain()
				}
				return
			}

			enqueueAppendLines(ev.fromSeq, ev.nextSeq, ev.lines)
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
				const m = store.meta()
				const nextN = parseSeq(m.nextSeq) ?? cursorN
				if (cursorN >= nextN) break
				const out = store.range({
					epoch: m.epoch,
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
				if (pending.some((x) => x.kind === 'gap')) break
			}

			// Switch to live processing, then flush buffered boundary appends.
			bufferingAppends = false
			for (let i = 0; i < bufferedAppends.length; i++) {
				const ev = bufferedAppends[i]!
				enqueueAppendLines(ev.fromSeq, ev.nextSeq, ev.lines)
				// If we had to overflow to a gap, stop and let the client resync.
				if (pending.some((x) => x.kind === 'gap')) break
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
	})
})

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

export default logsApp

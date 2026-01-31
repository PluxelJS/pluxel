import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

import { parseAfterId, parseLogFilter, resolveAfterId } from '../../logger/filters'
import { logStore, matchesFilter, type UiLogRecord } from '../../logger/logStore'

export const logsApp = new Hono()

// —— 静态快照：返回最近 N 条 JSON 日志 ——
logsApp.get('/latest', (c) => {
	const url = new URL(c.req.url)
	const filter = parseLogFilter(url.searchParams)
	const afterId = parseAfterId(url.searchParams)
	const limit = Math.min(
		Math.max(1, Number(url.searchParams.get('limit') ?? 200)),
		logStore.capacity,
	)
	const format = url.searchParams.get('format') ?? 'json'

	let records: UiLogRecord[] = []
	if (afterId !== undefined) {
		// After-id queries are naturally forward-only; stop early once we collected enough.
		const snap = logStore.snapshot(logStore.capacity, afterId)
		for (let i = 0; i < snap.length; i++) {
			const l = snap[i]!
			if (!matchesFilter(l, filter)) continue
			records.push(l)
			if (records.length >= limit) break
		}
	} else {
		// For "latest", we want the last N matching records without allocating/filtering the full buffer.
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

	if (format === 'jsonl' || format === 'ndjson') {
		const lines = records.map((l) => JSON.stringify(l)).join('\n') + '\n'
		return c.text(lines, 200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' })
	}

	return c.json({ records, lastId: logStore.lastId, bootId: logStore.bootId })
})

// —— 实时流：Server-Sent Events 推送 JSON 日志 ——
logsApp.get('/stream', (c) => {
	const url = new URL(c.req.url)
	const filter = parseLogFilter(url.searchParams)
	const afterId = resolveAfterId(url.searchParams, c.req.header('Last-Event-ID'))

	return streamSSE(c, async (sse) => {
		sse.writeSSE({
			event: 'ready',
			data: JSON.stringify({
				type: 'ready',
				filter,
				lastId: logStore.lastId,
				bootId: logStore.bootId,
			}),
		})

		if (afterId !== undefined) {
			for (const l of logStore.snapshot(logStore.capacity, afterId)) {
				if (!matchesFilter(l, filter)) continue
				sse.writeSSE({ event: 'log', id: String(l.id), data: JSON.stringify(l) })
			}
		}

		let aborted = false
		const onLog = (l: UiLogRecord) => {
			if (!matchesFilter(l, filter)) return
			sse.writeSSE({ event: 'log', id: String(l.id), data: JSON.stringify(l) })
		}
		const unsubscribe = logStore.subscribe(onLog)

		sse.onAbort(() => {
			aborted = true
			unsubscribe()
		})

		while (!aborted) {
			await sse.sleep(1000)
		}
	})
})

export default logsApp

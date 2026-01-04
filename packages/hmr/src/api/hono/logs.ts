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
	const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') ?? 200)), logStore.capacity)
	const format = url.searchParams.get('format') ?? 'json'

	const filtered = logStore.snapshot(logStore.capacity, afterId).filter((l) => matchesFilter(l, filter))
	const records = afterId ? filtered.slice(0, limit) : filtered.slice(-limit)

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
			data: JSON.stringify({ type: 'ready', filter, lastId: logStore.lastId, bootId: logStore.bootId }),
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

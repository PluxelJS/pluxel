// src/app.ts
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getOrderedLogs, events } from './createLogger'
import type { LogRecord } from './createLogger'

const app = new Hono()

// —— 静态快照，保持每行 JSON + 末尾换行 ——
app.get('/api/logs/latest', (c) => {
	const name = c.req.query('name') || ''
	const limit = Math.min(Number(c.req.query('limit') || 10), 100)

	const lines = getOrderedLogs()
		.filter((l) => !name || l.name === name)
		.slice(-limit)
		.map((l) => JSON.stringify(l))

	// 确保用 text/plain，LazyLog fetch() 默认也是 text
	return c.text(lines.join('\n') + '\n', 200, {
		'Content-Type': 'text/plain; charset=utf-8',
	})
})

// —— 实时流式：SSE ——
app.get('/api/logs/stream', (c) => {
	const name = c.req.query('name') || ''

	return streamSSE(
		c,
		async (sse) => {
			// 1) 先推历史
			getOrderedLogs()
				.filter((l) => !name || l.name === name)
				.forEach((l) => {
					sse.writeSSE({ data: JSON.stringify(l) })
				})

			// 2) 再订阅新日志
			const onLog = (l: LogRecord) => {
				if (!name || l.name === name) {
					sse.writeSSE({ data: JSON.stringify(l) })
				}
			}
			events.on('new_log', onLog)

			// 3) 客户端断开时，解绑 listener
			sse.onAbort(() => {
				events.off('new_log', onLog)
			})

			// 4) 永不 resolve，让连接保活
			await new Promise(() => {})
		},
		// 默认 onError 会 console.error
	)
})

export default app

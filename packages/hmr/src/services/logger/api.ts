// src/app.ts
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { LogRecord } from './createLogger'
import { events, getOrderedLogs } from './createLogger'

const app = new Hono()

// —— 静态快照：返回最近 N 条 JSON 日志 ——
app.get('/latest', (c) => {
	const name = c.req.query('name') ?? ''
	const limit = Math.min(Number(c.req.query('limit') ?? 10), 100)
	const lines = getOrderedLogs()
		.filter((l) => !name || l.name === name)
		.slice(-limit)
		.map((l) => JSON.stringify(l))
	return c.text(lines.join('\n') + '\n', 200, {
		'Content-Type': 'text/plain; charset=utf-8',
	})
})

// —— 实时流：Server-Sent Events 推送 JSON 日志 ——
app.get('/stream', (c) => {
	const name = c.req.query('name') ?? ''
	return streamSSE(c, async (sse) => {
		// 1) 推送历史日志
		getOrderedLogs()
			.filter((l) => !name || l.name === name)
			.forEach((l) => {
				sse.writeSSE({ data: JSON.stringify(l) })
			})

		// 2) 订阅新日志
		let aborted = false
		const onLog = (l: LogRecord) => {
			if (!name || l.name === name) {
				sse.writeSSE({ data: JSON.stringify(l) })
			}
		}
		events.on('new_log', onLog)

		// 3) 客户端断开时清理并标记
		sse.onAbort(() => {
			aborted = true
			events.off('new_log', onLog)
		})

		// 4) 保持连接，直到 aborted = true
		while (!aborted) {
			await sse.sleep(1000)
		}
		// 回调结束后，Hono 会自动关闭 SSE 流
	})
})

export default app

// src/app.ts
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { logStore, matchesFilter, type LogRecord } from './logStore'

const app = new Hono()

// —— 静态快照：返回最近 N 条 JSON 日志 ——
app.get('/latest', (c) => {
	const filter = c.req.query('name') ?? ''
	const limit = Math.min(Number(c.req.query('limit') ?? 10), 100)
	const lines = logStore
		.snapshot()
		.filter((l) => matchesFilter(l, filter))
		.slice(-limit)
		.map((l) => JSON.stringify(l))
	return c.text(lines.join('\n') + '\n', 200, {
		'Content-Type': 'text/plain; charset=utf-8',
	})
})

// —— 实时流：Server-Sent Events 推送 JSON 日志 ——
app.get('/stream', (c) => {
	const filter = c.req.query('name') ?? ''
	return streamSSE(c, async (sse) => {
		// 1) 推送历史日志
		logStore
			.snapshot()
			.filter((l) => matchesFilter(l, filter))
			.forEach((l) => {
				sse.writeSSE({ data: JSON.stringify(l) })
			})

		// 2) 订阅新日志
		let aborted = false
		const onLog = (l: LogRecord) => {
			if (matchesFilter(l, filter)) {
				sse.writeSSE({ data: JSON.stringify(l) })
			}
		}
		const unsubscribe = logStore.subscribe(onLog)

		// 3) 客户端断开时清理并标记
		sse.onAbort(() => {
			aborted = true
			unsubscribe()
		})

		// 4) 保持连接，直到 aborted = true
		while (!aborted) {
			await sse.sleep(1000)
		}
		// 回调结束后，Hono 会自动关闭 SSE 流
	})
})

export default app

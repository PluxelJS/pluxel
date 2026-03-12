export interface SseWriteMessage {
	event?: string
	data?: string
	id?: string
	retry?: number
}

export interface SseStreamWriter {
	onAbort(cb: () => void): void
	sleep(ms: number): Promise<void>
	write(chunk: string): Promise<void>
	writeSSE(message: SseWriteMessage): Promise<void>
}

function formatSseData(data: string): string {
	return data
		.split(/\r?\n/g)
		.map((line) => `data: ${line}`)
		.join('\n')
}

function formatSseMessage(message: SseWriteMessage): string {
	const lines: string[] = []
	if (message.event) lines.push(`event: ${message.event}`)
	if (message.id) lines.push(`id: ${message.id}`)
	if (message.retry !== undefined) lines.push(`retry: ${message.retry}`)
	if (message.data !== undefined) lines.push(formatSseData(message.data))
	return `${lines.join('\n')}\n\n`
}

export function createSseResponse(
	request: Request,
	handler: (writer: SseStreamWriter) => Promise<void> | void,
	headers?: HeadersInit,
): Response {
	const encoder = new TextEncoder()

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false
			const abortHandlers = new Set<() => void>()

			const close = () => {
				if (closed) return
				closed = true
				for (const cb of abortHandlers) cb()
				controller.close()
			}

			const abort = () => close()
			if (request.signal.aborted) {
				abort()
				return
			}
			request.signal.addEventListener('abort', abort, { once: true })

			const writer: SseStreamWriter = {
				onAbort(cb) {
					if (closed || request.signal.aborted) {
						cb()
						return
					}
					abortHandlers.add(cb)
				},
				sleep(ms) {
					return new Promise((resolve) => setTimeout(resolve, ms))
				},
				async write(chunk) {
					if (closed) return
					controller.enqueue(encoder.encode(chunk))
				},
				async writeSSE(message) {
					if (closed) return
					controller.enqueue(encoder.encode(formatSseMessage(message)))
				},
			}

			queueMicrotask(async () => {
				try {
					await handler(writer)
				} catch (error) {
					if (!closed) controller.error(error)
					return
				} finally {
					request.signal.removeEventListener('abort', abort)
					close()
				}
			})
		},
	})

	return new Response(stream, {
		status: 200,
		headers: {
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'Content-Type': 'text/event-stream; charset=utf-8',
			...(headers ? Object.fromEntries(new Headers(headers).entries()) : {}),
		},
	})
}

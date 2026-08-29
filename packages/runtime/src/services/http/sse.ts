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
	let cancelStream: (() => void) | undefined

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false
			const abortHandlers = new Set<() => void>()

			const terminate = (closeController: boolean) => {
				if (closed) return
				closed = true
				for (const cb of abortHandlers) {
					try {
						cb()
					} catch {
						// Cancellation is the terminal resource boundary. One faulty cleanup must not
						// prevent the remaining handlers from running or leak through stream.cancel().
					}
				}
				abortHandlers.clear()
				if (closeController) controller.close()
			}

			const abort = () => terminate(true)
			cancelStream = () => terminate(false)
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

			queueMicrotask(() => {
				void (async () => {
					try {
						await handler(writer)
					} catch (error) {
						if (!closed) controller.error(normalizeSseHandlerError(error))
						return
					} finally {
						request.signal.removeEventListener('abort', abort)
						terminate(true)
					}
				})().catch((): undefined => undefined)
			})
		},
		cancel() {
			cancelStream?.()
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

function normalizeSseHandlerError(cause: unknown): Error {
	if (cause instanceof Error) return cause
	const detail = cause === undefined ? 'without a rejection reason' : `with ${String(cause)}`
	return new Error(`[runtime:sse] stream handler failed ${detail}`, { cause })
}

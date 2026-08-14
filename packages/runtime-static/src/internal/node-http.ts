import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export type NodeFetchRequest = Readonly<{
	request: Request
	signal: AbortSignal
	dispose(): void
}>

/** Bridges one Node HTTP exchange to Fetch while preserving client-disconnect cancellation. */
export function createNodeFetchRequest(
	incoming: IncomingMessage,
	response: ServerResponse,
	origin: string,
): NodeFetchRequest {
	const controller = new AbortController()
	const abort = () => {
		if (!controller.signal.aborted) {
			controller.abort(new Error('Node HTTP client disconnected'))
		}
	}
	const onResponseClose = () => {
		if (!response.writableFinished) abort()
	}
	incoming.once('aborted', abort)
	response.once('close', onResponseClose)
	if (incoming.aborted || response.destroyed) abort()

	const method = (incoming.method ?? 'GET').toUpperCase()
	const headers = new Headers()
	for (const [key, value] of Object.entries(incoming.headers)) {
		if (Array.isArray(value)) for (const item of value) headers.append(key, item)
		else if (value !== undefined) headers.set(key, value)
	}
	const body = method === 'GET' || method === 'HEAD' ? undefined : Readable.toWeb(incoming)
	const requestInit: RequestInit & { duplex?: 'half' } = {
		method,
		headers,
		body: body as unknown as BodyInit | undefined,
		duplex: body ? 'half' : undefined,
		signal: controller.signal,
	}
	const request = new Request(new URL(incoming.url ?? '/', origin), requestInit)

	return Object.freeze({
		request,
		signal: controller.signal,
		dispose() {
			incoming.removeListener('aborted', abort)
			response.removeListener('close', onResponseClose)
		},
	})
}

/** Writes a Fetch response with backpressure and destroys its body when the Node peer leaves. */
export async function writeNodeFetchResponse(
	response: ServerResponse,
	result: Response,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted) {
		await result.body?.cancel(signal.reason).catch((): void => undefined)
		return
	}
	response.statusCode = result.status
	for (const [key, value] of result.headers) response.setHeader(key, value)
	if (!result.body) {
		response.end()
		return
	}

	const body = Readable.fromWeb(result.body as never)
	try {
		await pipeline(body, response, { signal })
	} catch (error) {
		if (!signal.aborted && !response.destroyed) throw error
	}
}

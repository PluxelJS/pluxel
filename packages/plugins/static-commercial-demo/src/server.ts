import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http'
import { Readable } from 'node:stream'

type FetchHostServerOptions = {
	host?: string
	port?: number | string
	fetch: (request: Request) => Promise<Response> | Response
}

type FetchHostServer = {
	host: string
	port: number
	baseUrl: string
	close(): Promise<void>
}

function toFetchHeaders(headers: IncomingHttpHeaders): Headers {
	const out = new Headers()
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const item of value) out.append(key, item)
			continue
		}
		out.set(key, String(value))
	}
	return out
}

function toFetchRequest(req: IncomingMessage, baseUrl: string): Request {
	const method = req.method ?? 'GET'
	const init: RequestInit & { duplex?: 'half' } = {
		method,
		headers: toFetchHeaders(req.headers),
		body:
			method === 'GET' || method === 'HEAD'
				? undefined
				: (Readable.toWeb(req) as unknown as BodyInit),
	}
	if (init.body) init.duplex = 'half'
	return new Request(new URL(req.url ?? '/', baseUrl), init)
}

async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
	res.statusCode = response.status
	for (const [key, value] of response.headers) res.setHeader(key, value)
	if (!response.body) {
		res.end()
		return
	}

	await new Promise<void>((resolve, reject) => {
		Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream)
			.on('error', reject)
			.pipe(res)
			.on('finish', resolve)
			.on('error', reject)
	})
}

export async function startFetchHostServer(
	options: FetchHostServerOptions,
): Promise<FetchHostServer> {
	const host = options.host ?? '127.0.0.1'
	const port = Number(options.port ?? 3312)
	const baseUrl = `http://${host}:${port}`
	const server = createServer(async (req, res) => {
		try {
			const request = toFetchRequest(req, baseUrl)
			const response = await options.fetch(request)
			await writeFetchResponse(res, response)
		} catch (error) {
			res.statusCode = 500
			res.setHeader('content-type', 'text/plain; charset=utf-8')
			res.end(error instanceof Error ? (error.stack ?? error.message) : String(error))
		}
	})

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, host, () => {
			server.off('error', reject)
			resolve()
		})
	})

	return {
		host,
		port,
		baseUrl,
		close: async () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => {
					if (error) reject(error)
					else resolve()
				}),
			),
	}
}

export function installShutdown(onClose: (signal: 'SIGINT' | 'SIGTERM') => Promise<void>): void {
	let closing = false
	async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
		if (closing) return
		closing = true
		await onClose(signal)
		process.exit(0)
	}

	process.on('SIGINT', () => void shutdown('SIGINT'))
	process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

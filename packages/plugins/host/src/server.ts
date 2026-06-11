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

function toFetchRequest(
	req: IncomingMessage,
	baseUrl: string,
): Request {
	const url = new URL(req.url ?? '/', baseUrl)
	const method = req.method ?? 'GET'
	const init: RequestInit & { duplex?: 'half' } = {
		method,
		headers: toFetchHeaders(req.headers),
		body: method === 'GET' || method === 'HEAD' ? undefined : Readable.toWeb(req),
	}
	if (init.body) init.duplex = 'half'
	return new Request(url, init)
}

async function writeFetchResponse(
	res: ServerResponse,
	response: Response,
): Promise<void> {
	res.statusCode = response.status
	for (const [key, value] of response.headers) res.setHeader(key, value)

	if (!response.body) {
		res.end()
		return
	}

	await new Promise<void>((resolvePromise, reject) => {
		Readable.fromWeb(response.body)
			.on('error', reject)
			.pipe(res)
			.on('finish', resolvePromise)
			.on('error', reject)
	})
}

export async function startFetchHostServer(
	options: FetchHostServerOptions,
): Promise<FetchHostServer> {
	const host = options.host ?? '127.0.0.1'
	const port = Number(options.port ?? 3310)
	const server = createServer(async (req, res) => {
		try {
			const request = toFetchRequest(req, `http://${host}:${port}`)
			const response = await options.fetch(request)
			await writeFetchResponse(res, response)
		} catch (error) {
			res.statusCode = 500
			res.setHeader('Content-Type', 'text/plain; charset=utf-8')
			res.end(error instanceof Error ? (error.stack ?? error.message) : String(error))
		}
	})

	await new Promise<void>((resolvePromise, reject) => {
		server.once('error', reject)
		server.listen(port, host, () => {
			server.off('error', reject)
			resolvePromise()
		})
	})

	return {
		host,
		port,
		baseUrl: `http://${host}:${port}`,
		close: async () =>
			new Promise<void>((resolvePromise, reject) =>
				server.close((error) => {
					if (error) reject(error)
					else resolvePromise()
				}),
			),
	}
}

export function installShutdown(
	label: string,
	onClose: (signal: 'SIGINT' | 'SIGTERM') => Promise<void>,
): (messageLogger: (label: string, error: unknown) => Promise<void> | void) => void {
	let closing = false
	async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
		if (closing) return
		closing = true
		await onClose(signal)
		process.exit(0)
	}

	process.on('SIGINT', () => void shutdown('SIGINT'))
	process.on('SIGTERM', () => void shutdown('SIGTERM'))

	return (messageLogger) => {
		process.on('uncaughtException', (error) => {
			void messageLogger(`${label} uncaught exception`, error)
		})
		process.on('unhandledRejection', (error) => {
			void messageLogger(`${label} unhandled rejection`, error)
		})
	}
}

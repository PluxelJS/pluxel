import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http'
import { Readable } from 'node:stream'

type Options = {
	host: string
	port: number
	fetch: (request: Request) => Response | Promise<Response>
}

function headersOf(input: IncomingHttpHeaders): Headers {
	const headers = new Headers()
	for (const [key, value] of Object.entries(input)) {
		if (Array.isArray(value)) value.forEach((item) => headers.append(key, item))
		else if (value !== undefined) headers.set(key, String(value))
	}
	return headers
}

function requestOf(req: IncomingMessage, baseUrl: string): Request {
	const method = req.method ?? 'GET'
	const body =
		method === 'GET' || method === 'HEAD' ? undefined : (Readable.toWeb(req) as unknown as BodyInit)
	return new Request(new URL(req.url ?? '/', baseUrl), {
		method,
		headers: headersOf(req.headers),
		body,
		...(body ? { duplex: 'half' as const } : {}),
	})
}

async function respond(res: ServerResponse, response: Response): Promise<void> {
	res.statusCode = response.status
	for (const [key, value] of response.headers) res.setHeader(key, value)
	if (!response.body) return void res.end()
	await new Promise<void>((resolve, reject) => {
		Readable.fromWeb(response.body as never)
			.on('error', reject)
			.pipe(res)
			.on('finish', resolve)
			.on('error', reject)
	})
}

export async function startFetchHostServer(options: Options) {
	const baseUrl = `http://${options.host}:${options.port}`
	const server = createServer(async (req, res) => {
		try {
			await respond(res, await options.fetch(requestOf(req, baseUrl)))
		} catch (error) {
			res.statusCode = 500
			res.end(error instanceof Error ? error.message : String(error))
		}
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(options.port, options.host, resolve)
	})
	return {
		baseUrl,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error)
						return
					}
					resolve()
				})
			}),
	}
}

export function installShutdown(close: (signal: 'SIGINT' | 'SIGTERM') => Promise<void>): void {
	let closing = false
	const run = async (signal: 'SIGINT' | 'SIGTERM') => {
		if (closing) return
		closing = true
		await close(signal)
		process.exit(0)
	}
	process.on('SIGINT', () => void run('SIGINT'))
	process.on('SIGTERM', () => void run('SIGTERM'))
}

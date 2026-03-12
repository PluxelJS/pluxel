import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import picomatch from 'picomatch'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

import type { HttpHandler } from './HttpService'

export interface FetchDevServerPluginOptions {
	exclude?: Array<string | RegExp>
	fetch: HttpHandler
	handleHotUpdate?: Plugin['handleHotUpdate']
	injectClientScript?: boolean
}

function shouldSkipBody(method: string) {
	return method === 'GET' || method === 'HEAD'
}

function resolveOrigin(req: IncomingMessage): string {
	const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim()
	const host = req.headers.host ?? 'localhost'
	return `${proto === 'https' ? 'https' : 'http'}://${host}`
}

function toRequest(req: IncomingMessage): Request {
	const method = (req.method ?? 'GET').toUpperCase()
	const url = new URL(req.url ?? '/', resolveOrigin(req))
	const init: RequestInit & { duplex?: 'half' } = {
		method,
		headers: req.headers as HeadersInit,
	}

	if (!shouldSkipBody(method)) {
		init.body = Readable.toWeb(req) as unknown as BodyInit
		init.duplex = 'half'
	}

	return new Request(url, init)
}

function appendSetCookies(headers: Headers, res: ServerResponse) {
	const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
	if (typeof getSetCookie === 'function') {
		const values = getSetCookie.call(headers)
		if (values.length) {
			res.setHeader('set-cookie', values)
			return
		}
	}

	const single = headers.get('set-cookie')
	if (single) res.setHeader('set-cookie', single)
}

async function sendResponse(res: ServerResponse, response: Response) {
	res.statusCode = response.status

	response.headers.forEach((value, key) => {
		if (key.toLowerCase() === 'set-cookie') return
		res.setHeader(key, value)
	})
	appendSetCookies(response.headers, res)

	if (!response.body) {
		res.end()
		return
	}

	await new Promise<void>((resolve, reject) => {
		const stream = Readable.fromWeb(response.body as unknown as NodeReadableStream)
		stream.on('error', reject)
		res.on('close', resolve)
		res.on('finish', resolve)
		stream.pipe(res)
	})
}

function isHtmlResponse(response: Response) {
	return (response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')
}

function withInjectedViteClient(response: Response, base: string): Response {
	if (!response.body) return response
	const clientUrl = base === '/' ? '/@vite/client' : `${base.replace(/\/$/, '')}/@vite/client`
	const nonce = response.headers.get('content-security-policy')?.match(/'nonce-([^']+)'/)?.[1]
	const snippet = `<script${nonce ? ` nonce="${nonce}"` : ''}>import("${clientUrl}")</script>`
	const extra = new TextEncoder().encode(snippet)
	const reader = response.body.getReader()

	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			while (true) {
				const result = await reader.read()
				if (result.done) break
				controller.enqueue(result.value)
			}
			controller.enqueue(extra)
			controller.close()
		},
	})

	const headers = new Headers(response.headers)
	headers.delete('content-length')
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

export function createFetchDevServerPlugin(options: FetchDevServerPluginOptions): Plugin {
	const exclude = (options.exclude ?? []).map((pattern) =>
		typeof pattern === 'string' ? picomatch(pattern) : pattern,
	)
	let viteBase = '/'

	return {
		name: 'pluxel-fetch-dev-server',
		configResolved(config) {
			viteBase = config.base || '/'
		},
		config() {
			return {
				server: {
					watch: {
						ignored: [/\.wrangler/, /\.mf/],
					},
				},
			}
		},
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				const rawUrl = req.url ?? '/'
				for (const pattern of exclude) {
					const matched =
						pattern instanceof RegExp ? pattern.test(rawUrl) : pattern(rawUrl)
					if (matched) return next()
				}

				let response: Response
				try {
					response = await options.fetch(toRequest(req))
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error))
					server.ssrFixStacktrace(err)
					next(err)
					return
				}

				try {
					const out =
						options.injectClientScript === false || !isHtmlResponse(response)
							? response
							: withInjectedViteClient(response, viteBase)
					await sendResponse(res, out)
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error))
					server.ssrFixStacktrace(err)
					next(err)
				}
			})
		},
		handleHotUpdate: options.handleHotUpdate,
	}
}

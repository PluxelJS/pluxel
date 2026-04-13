import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { HttpHandler } from './HttpService'

function shouldSkipBody(method: string) {
	return method === 'GET' || method === 'HEAD'
}

function resolveOrigin(req: IncomingMessage): string {
	const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim()
	const host = req.headers.host ?? 'localhost'
	return `${proto === 'https' ? 'https' : 'http'}://${host}`
}

export function toWebRequest(req: IncomingMessage): Request {
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
		if (values.length > 0) {
			res.setHeader('set-cookie', values)
			return
		}
	}

	const single = headers.get('set-cookie')
	if (single) res.setHeader('set-cookie', single)
}

export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
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

export type ConnectMiddleware = (
	req: IncomingMessage,
	res: ServerResponse,
	next: (err?: unknown) => void,
) => void

export type CreateConnectFetchMiddlewareOptions = {
	/**
	 * Only handle requests whose `req.url` starts with this base path.
	 *
	 * Prefer mounting the middleware at the root (no `app.use(base, ...)`) and using this filter,
	 * so `req.url` retains the original prefix expected by runtime routes.
	 */
	matchBase?: string
}

export function createConnectFetchMiddleware(
	fetch: HttpHandler,
	options: CreateConnectFetchMiddlewareOptions = {},
): ConnectMiddleware {
	const matchBase = options.matchBase?.replace(/\/+$/, '') || null

	return async (req, res, next) => {
		const rawUrl = req.url ?? '/'
		if (matchBase && !rawUrl.startsWith(matchBase)) return next()

		let response: Response
		try {
			response = await fetch(toWebRequest(req))
		} catch (error) {
			next(error)
			return
		}

		try {
			await sendWebResponse(res, response)
		} catch (error) {
			next(error)
		}
	}
}

export function createNodeHttpHandler(fetch: HttpHandler) {
	return (req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			try {
				const response = await fetch(toWebRequest(req))
				await sendWebResponse(res, response)
			} catch (error) {
				res.statusCode = 500
				res.setHeader('content-type', 'text/plain; charset=utf-8')
				res.end(error instanceof Error ? error.message : String(error))
			}
		})()
	}
}

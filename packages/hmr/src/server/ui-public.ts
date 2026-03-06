import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, resolve } from 'pathe'
import { normalizePath } from 'vite'

export const UI_PUBLIC_BASE = '/dist/public'
export const UI_PUBLIC_MOUNT_RE = /^\/dist\/public(?:\/.*)?$/

type UiPublicRequest = {
	method?: unknown
	url?: unknown
	headers?: Record<string, unknown> | undefined
}

type UiPublicResponse = NodeJS.WritableStream & {
	statusCode: number
	headersSent?: boolean
	setHeader: (name: string, value: string) => void
	end: (chunk?: unknown) => void
}

type UiPublicNext = (err?: unknown) => void

export type UiPublicStaticMiddleware = (
	req: UiPublicRequest,
	res: UiPublicResponse,
	next: UiPublicNext,
) => void | Promise<void>

function stripTrailingSlashes(pathname: string): string {
	return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
}

function contentTypeByExt(ext: string): string | undefined {
	switch (ext) {
		case '.css':
			return 'text/css; charset=utf-8'
		case '.js':
		case '.mjs':
			return 'application/javascript; charset=utf-8'
		case '.json':
		case '.map':
			return 'application/json; charset=utf-8'
		case '.svg':
			return 'image/svg+xml; charset=utf-8'
		case '.woff2':
			return 'font/woff2'
		case '.woff':
			return 'font/woff'
		case '.ttf':
			return 'font/ttf'
		case '.png':
			return 'image/png'
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg'
		case '.gif':
			return 'image/gif'
		case '.webp':
			return 'image/webp'
		default:
			return undefined
	}
}

function getCacheControl(pathname: string): string {
	// `dist/public` is expected to contain Vite-hashed assets; allow aggressive caching by default.
	// Keep `.html` conservative (e.g. `/dist/public/index.html` if it exists).
	if (pathname.toLowerCase().endsWith('.html')) return 'no-cache'
	return 'public, max-age=31536000, immutable'
}

function sendText(res: UiPublicResponse, status: number, message: string) {
	res.statusCode = status
	res.setHeader('Content-Type', 'text/plain; charset=utf-8')
	res.end(message)
}

/**
 * Static file middleware for serving the built HMR UI (`dist/public`).
 *
 * Intended to be mounted via Connect/Vite middlewares, so `req.url` is expected to be
 * relative to the mount root (e.g. `/assets/app.js`).
 */
export function createUiPublicStaticMiddleware(
	publicDirAbs: string,
): UiPublicStaticMiddleware | null {
	const publicDirNorm = stripTrailingSlashes(normalizePath(publicDirAbs))
	if (!existsSync(publicDirAbs)) return null

	return async (req: UiPublicRequest, res: UiPublicResponse, next: UiPublicNext) => {
		try {
			const method = String(req?.method ?? 'GET').toUpperCase()
			if (method !== 'GET' && method !== 'HEAD') {
				res.setHeader('Allow', 'GET, HEAD')
				return sendText(res, 405, 'Method Not Allowed')
			}

			const rawUrl = typeof req?.url === 'string' ? req.url : '/'
			const { pathname } = new URL(rawUrl, 'http://localhost')

			let decodedPath: string
			try {
				decodedPath = decodeURIComponent(pathname)
			} catch {
				return sendText(res, 400, 'Bad Request')
			}

			const abs = resolve(publicDirAbs, `.${decodedPath}`)
			const absNorm = normalizePath(abs)
			if (!absNorm.startsWith(`${publicDirNorm}/`)) return sendText(res, 404, 'Not Found')

			const st = await stat(abs).catch((): null => null)
			if (!st?.isFile()) return sendText(res, 404, 'Not Found')

			const type = contentTypeByExt(extname(absNorm).toLowerCase()) ?? 'application/octet-stream'
			res.setHeader('Content-Type', type)
			res.setHeader('Cache-Control', getCacheControl(absNorm))
			res.setHeader('Content-Length', String(st.size))
			res.setHeader('Last-Modified', st.mtime.toUTCString())
			const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`
			res.setHeader('ETag', etag)

			const ifNoneMatch = String(req.headers?.['if-none-match'] ?? '')
			if (ifNoneMatch && ifNoneMatch === etag) {
				res.statusCode = 304
				res.end()
				return
			}

			if (method === 'HEAD') {
				res.statusCode = 200
				res.end()
				return
			}

			res.statusCode = 200
			const stream = createReadStream(abs)
			stream.on('error', () => {
				if (!res.headersSent) res.statusCode = 500
				try {
					res.end()
				} catch {
					// ignore
				}
			})
			stream.pipe(res)
			return
		} catch {
			return next()
		}
	}
}

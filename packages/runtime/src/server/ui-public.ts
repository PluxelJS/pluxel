import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { dirname, extname, resolve } from 'pathe'

import { UI_PUBLIC_BASE } from '../web/paths'
export { UI_PUBLIC_BASE } from '../web/paths'

export type UiPublicAssetHandler = (request: Request) => Promise<Response | null>

function stripTrailingSlashes(pathname: string): string {
	return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
}

function normalizeFsPath(pathname: string): string {
	return pathname.replaceAll('\\', '/')
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
	if (pathname.toLowerCase().endsWith('.html')) return 'no-cache'
	return 'public, max-age=31536000, immutable'
}

function resolveUiPublicDirCandidates(moduleDir: string): string[] {
	return [
		// dist build: `dist/server/*` → `dist/public`
		resolve(moduleDir, '../../public'),
		// fallback layouts (dev/source)
		resolve(moduleDir, '../public'),
		resolve(moduleDir, './public'),
	]
}

export function resolveDefaultUiPublicDir(): string | null {
	const moduleDir = dirname(fileURLToPath(import.meta.url))
	for (const candidate of resolveUiPublicDirCandidates(moduleDir)) {
		if (existsSync(candidate)) return candidate
	}
	return null
}

async function sendFile(request: Request, absPath: string, absNorm: string): Promise<Response> {
	const st = await stat(absPath).catch((): null => null)
	if (!st?.isFile()) return new Response('Not Found', { status: 404 })

	const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`
	const ifNoneMatch = request.headers.get('if-none-match') ?? ''
	if (ifNoneMatch && ifNoneMatch === etag) {
		return new Response(null, {
			status: 304,
			headers: {
				etag,
				'cache-control': getCacheControl(absNorm),
			},
		})
	}

	const headers: HeadersInit = {
		etag,
		'last-modified': st.mtime.toUTCString(),
		'cache-control': getCacheControl(absNorm),
		'content-length': String(st.size),
		'content-type': contentTypeByExt(extname(absNorm).toLowerCase()) ?? 'application/octet-stream',
	}

	const method = (request.method ?? 'GET').toUpperCase()
	if (method === 'HEAD') return new Response(null, { status: 200, headers })

	const stream = createReadStream(absPath)
	const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
	return new Response(body, { status: 200, headers })
}

export function createUiPublicAssetHandler(options: {
	publicDirAbs: string
}): UiPublicAssetHandler {
	const publicDirNorm = stripTrailingSlashes(normalizeFsPath(options.publicDirAbs))
	return async (request: Request) => {
		const method = (request.method ?? 'GET').toUpperCase()
		if (method !== 'GET' && method !== 'HEAD') {
			return new Response('Method Not Allowed', {
				status: 405,
				headers: { allow: 'GET, HEAD' },
			})
		}

		const { pathname } = new URL(request.url)
		if (!pathname.startsWith(`${UI_PUBLIC_BASE}/`)) return null

		let decodedPath: string
		try {
			decodedPath = decodeURIComponent(pathname)
		} catch {
			return new Response('Bad Request', { status: 400 })
		}

		const rel = decodedPath.slice(UI_PUBLIC_BASE.length) // starts with '/'
		const abs = resolve(options.publicDirAbs, `.${rel}`)
		const absNorm = normalizeFsPath(abs)
		if (!absNorm.startsWith(`${publicDirNorm}/`)) return new Response('Not Found', { status: 404 })

		return sendFile(request, abs, absNorm)
	}
}

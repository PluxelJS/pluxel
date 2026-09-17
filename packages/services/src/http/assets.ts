import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve as resolvePath } from 'node:path'
import { Readable } from 'node:stream'

export async function resolveApplicationAsset(
	request: Request,
	publicDir: string,
): Promise<Response | null> {
	if (request.method !== 'GET' && request.method !== 'HEAD') return null
	let pathname: string
	try {
		pathname = decodeURIComponent(new URL(request.url).pathname)
	} catch {
		return null
	}
	const relativePath = pathname.replace(/^\/+/, '')
	const direct = relativePath
		? resolvePath(publicDir, relativePath)
		: resolvePath(publicDir, 'index.html')
	const directAsset = await toApplicationAssetResponse(request, publicDir, direct)
	if (directAsset) return directAsset
	if (!request.headers.get('accept')?.toLowerCase().includes('text/html')) return null
	return toApplicationAssetResponse(request, publicDir, resolvePath(publicDir, 'index.html'))
}

async function toApplicationAssetResponse(
	request: Request,
	publicDir: string,
	path: string,
): Promise<Response | null> {
	const relativePath = relative(publicDir, path)
	if (relativePath.startsWith('..') || isAbsolute(relativePath)) return null
	const fileStat = await stat(path).catch((): null => null)
	if (!fileStat?.isFile()) return null
	const headers = new Headers({
		'content-length': String(fileStat.size),
		'content-type': applicationContentType(path),
	})
	if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
	return new Response(Readable.toWeb(createReadStream(path)) as unknown as BodyInit, {
		status: 200,
		headers,
	})
}

function applicationContentType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case '.html':
			return 'text/html; charset=utf-8'
		case '.css':
			return 'text/css; charset=utf-8'
		case '.js':
		case '.mjs':
			return 'application/javascript; charset=utf-8'
		case '.json':
			return 'application/json; charset=utf-8'
		case '.svg':
			return 'image/svg+xml'
		case '.png':
			return 'image/png'
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg'
		case '.webp':
			return 'image/webp'
		case '.woff2':
			return 'font/woff2'
		default:
			return 'application/octet-stream'
	}
}

import type { IncomingMessage } from 'node:http'

export type RuntimeHttpRouteContext = {
	http: {
		matchesMountedRoute?: (pathname: string) => boolean
	}
}

export function isRuntimeHttpRouteRequest(
	request: IncomingMessage,
	ctx: RuntimeHttpRouteContext,
): boolean {
	const url = request.url ?? '/'
	const pathname = requestPathname(url)
	if (url.startsWith('/__pluxel/')) return true
	if (ctx.http.matchesMountedRoute?.(pathname)) return true

	const method = (request.method ?? 'GET').toUpperCase()
	if (method !== 'GET' && method !== 'HEAD') return false
	if (url.startsWith('/@') || url.startsWith('/node_modules/') || url.includes('.')) return false

	const accept = String(request.headers.accept ?? '').toLowerCase()
	return accept.includes('text/html')
}

function requestPathname(url: string): string {
	try {
		return new URL(url, 'http://local').pathname
	} catch {
		return url.split(/[?#]/, 1)[0] || '/'
	}
}

import type { IncomingMessage } from 'node:http'
import { UI_PUBLIC_BASE } from '@pluxel/runtime/internal'

export type RuntimeHttpRouteContext = {
	workbench?: unknown
	http: {
		matchesMountedRoute?: (pathname: string) => boolean
		matchesWorkbenchUiRoute?: (pathname: string) => boolean
	}
}

export function isRuntimeHttpRouteRequest(
	request: IncomingMessage,
	ctx: RuntimeHttpRouteContext,
): boolean {
	const url = request.url ?? '/'
	const pathname = requestPathname(url)
	if (url.startsWith('/__pluxel/')) return true
	const workbenchEnabled = ctx.workbench !== undefined
	if (workbenchEnabled && pathname.startsWith(`${UI_PUBLIC_BASE}/`)) return true
	if (ctx.http.matchesMountedRoute?.(pathname)) return true

	const method = (request.method ?? 'GET').toUpperCase()
	if (method !== 'GET' && method !== 'HEAD') return false
	if (url.startsWith('/@') || url.startsWith('/node_modules/') || url.includes('.')) return false
	if (!workbenchEnabled) return false

	const accept = String(request.headers.accept ?? '').toLowerCase()
	return accept.includes('text/html') && ctx.http.matchesWorkbenchUiRoute?.(pathname) === true
}

function requestPathname(url: string): string {
	try {
		return new URL(url, 'http://local').pathname
	} catch {
		return url.split(/[?#]/, 1)[0] || '/'
	}
}

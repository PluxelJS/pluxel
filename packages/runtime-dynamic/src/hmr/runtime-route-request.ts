import type { IncomingMessage } from 'node:http'
import type { Context } from '@pluxel/core'
import { requireRuntimeHttpService, UI_PUBLIC_BASE } from '@pluxel/runtime/internal'

export type RuntimeHttpRouteContext = Context

export function isRuntimeHttpRouteRequest(
	request: IncomingMessage,
	ctx: RuntimeHttpRouteContext,
): boolean {
	const url = request.url ?? '/'
	const pathname = requestPathname(url)
	const http = requireRuntimeHttpService(ctx)
	if (url.startsWith('/__pluxel/')) return true
	const workbenchEnabled = ctx.workbench !== undefined
	if (workbenchEnabled && pathname.startsWith(`${UI_PUBLIC_BASE}/`)) return true
	if (http.matchesMountedRoute(pathname)) return true

	const method = (request.method ?? 'GET').toUpperCase()
	if (method !== 'GET' && method !== 'HEAD') return false
	if (url.startsWith('/@') || url.startsWith('/node_modules/') || url.includes('.')) return false
	if (!workbenchEnabled) return false

	const accept = String(request.headers.accept ?? '').toLowerCase()
	return accept.includes('text/html') && http.matchesWorkbenchUiRoute(pathname) === true
}

function requestPathname(url: string): string {
	try {
		return new URL(url, 'http://local').pathname
	} catch {
		return url.split(/[?#]/, 1)[0] || '/'
	}
}

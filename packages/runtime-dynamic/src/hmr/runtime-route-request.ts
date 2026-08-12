import type { IncomingMessage } from 'node:http'
import {
	isWorkbenchEnabled,
	matchesWorkbenchUiBasePath,
	resolveWorkbenchUiBasePath,
} from '@pluxel/runtime/internal'
import { UI_PUBLIC_BASE } from '@pluxel/runtime/web/paths'

export type RuntimeHttpRouteContext = {
	config: {
		workbench?: import('@pluxel/runtime').WorkbenchConfig
	}
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
	const workbenchEnabled = isWorkbenchEnabled(ctx.config.workbench)
	if (workbenchEnabled && pathname.startsWith(`${UI_PUBLIC_BASE}/`)) return true
	if (ctx.http.matchesMountedRoute?.(pathname)) return true

	const method = (request.method ?? 'GET').toUpperCase()
	if (method !== 'GET' && method !== 'HEAD') return false
	if (url.startsWith('/@') || url.startsWith('/node_modules/') || url.includes('.')) return false
	if (!workbenchEnabled) return false

	const accept = String(request.headers.accept ?? '').toLowerCase()
	return (
		accept.includes('text/html') &&
		matchesWorkbenchUiBasePath(pathname, resolveWorkbenchUiBasePath(ctx.config.workbench))
	)
}

function requestPathname(url: string): string {
	try {
		return new URL(url, 'http://local').pathname
	} catch {
		return url.split(/[?#]/, 1)[0] || '/'
	}
}

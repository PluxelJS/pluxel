import { UI_PUBLIC_BASE } from '@pluxel/runtime/internal'

export function shouldHandleRuntimeViteRequest(input: {
	url: string
	method: string | undefined
	accept: string | undefined
	workbenchEnabled: boolean
	matchesMountedRoute: (pathname: string) => boolean
	matchesWorkbenchUiRoute: (pathname: string) => boolean
}): boolean {
	const pathname = requestPathname(input.url)
	if (input.url.startsWith('/__pluxel/')) return true
	if (input.workbenchEnabled && pathname.startsWith(`${UI_PUBLIC_BASE}/`)) return true
	if (input.matchesMountedRoute(pathname)) return true

	// Vite owns its internal module and dependency paths even when a browser requests them directly.
	if (input.url.startsWith('/@') || input.url.startsWith('/node_modules/')) return false

	const method = (input.method ?? 'GET').toUpperCase()
	if (method !== 'GET' && method !== 'HEAD') return false
	if (!input.workbenchEnabled) return false

	// A document navigation is identified by HTTP semantics, not by filename punctuation. Plugin
	// identity routes can legitimately contain source/package segments such as `plugin.ts`.
	const accept = (input.accept ?? '').toLowerCase()
	return accept.includes('text/html') && input.matchesWorkbenchUiRoute(pathname)
}

function requestPathname(url: string): string {
	try {
		return new URL(url, 'http://local').pathname
	} catch {
		return url.split(/[?#]/, 1)[0] || '/'
	}
}

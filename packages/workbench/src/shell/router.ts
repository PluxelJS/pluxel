import { UI_PUBLIC_ASSET_BASE } from '@pluxel/management/internal/web/paths'
import { matchesWorkbenchUiBasePath } from './config'
import type { RenderHandler } from './types'
import type { UiPublicAssetHandler } from './ui-public'

/** Shared request arbitration for packaged and explicitly attached source Shells. */
export function createShellRouter(options: {
	uiBasePath: string
	render: RenderHandler
	assets: UiPublicAssetHandler
}) {
	const isAsset = (pathname: string) =>
		pathname === UI_PUBLIC_ASSET_BASE || pathname.startsWith(`${UI_PUBLIC_ASSET_BASE}/`)
	const matchesRequest = (request: Request): boolean => {
		const { pathname } = new URL(request.url)
		return (
			isAsset(pathname) ||
			(matchesWorkbenchUiBasePath(pathname, options.uiBasePath) && isHtmlNavigation(request))
		)
	}
	const fetch = async (request: Request): Promise<Response | null> => {
		if (!matchesRequest(request)) return null
		if (isAsset(new URL(request.url).pathname))
			return (await options.assets(request)) ?? new Response('Not Found', { status: 404 })
		const response = await options.render(request)
		return request.method === 'HEAD'
			? new Response(null, { status: response.status, headers: response.headers })
			: response
	}
	return Object.assign(fetch, { matchesRequest })
}

function isHtmlNavigation(request: Request): boolean {
	if (request.method !== 'GET' && request.method !== 'HEAD') return false
	const accept = (request.headers.get('accept') ?? '').toLowerCase()
	if (!accept.includes('text/html') && accept.trim() !== '*/*') return false
	const mode = request.headers.get('sec-fetch-mode')
	if (mode && mode !== 'navigate') return false
	const destination = request.headers.get('sec-fetch-dest')
	return !destination || destination === 'document' || destination === 'iframe'
}

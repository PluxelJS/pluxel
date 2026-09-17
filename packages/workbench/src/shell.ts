import { resolve } from 'pathe'
import { createStaticRenderer } from './shell/static'
import { createUiPublicAssetHandler, resolveDefaultUiPublicDir } from './shell/ui-public'
import { matchesWorkbenchUiBasePath, normalizeWorkbenchUiBasePath } from './shell/config'
import { UI_PUBLIC_ASSET_BASE } from '@pluxel/management/internal/web/paths'

export interface WorkbenchShellOptions {
	/** Browser navigation path. Defaults to `/`. */
	readonly uiBasePath?: string
	/** Built UI directory containing `.vite/manifest.json` and `assets/`. Defaults to packaged assets. */
	readonly publicDir?: string
}

/** A borrowed fetch fallback: call after business routes. Non-shell requests return null. */
export async function createWorkbenchShellHandler(options: WorkbenchShellOptions = {}) {
	const uiBasePath = normalizeWorkbenchUiBasePath(options.uiBasePath)
	const publicDirAbs = options.publicDir ? resolve(options.publicDir) : resolveDefaultUiPublicDir()
	if (!publicDirAbs) throw new Error('Packaged Workbench UI assets are unavailable')
	const assets = createUiPublicAssetHandler({ publicDirAbs })
	const render = await createStaticRenderer({ publicDirAbs, uiBasePath })
	const matchesRequest = (request: Request): boolean => {
		const { pathname } = new URL(request.url)
		return (
			pathname === UI_PUBLIC_ASSET_BASE ||
			pathname.startsWith(`${UI_PUBLIC_ASSET_BASE}/`) ||
			(matchesWorkbenchUiBasePath(pathname, uiBasePath) && isHtmlNavigation(request))
		)
	}
	const fetch = async (request: Request): Promise<Response | null> => {
		const { pathname } = new URL(request.url)
		if (pathname === UI_PUBLIC_ASSET_BASE || pathname.startsWith(`${UI_PUBLIC_ASSET_BASE}/`))
			return (await assets(request)) ?? new Response('Not Found', { status: 404 })
		if (!matchesWorkbenchUiBasePath(pathname, uiBasePath) || !isHtmlNavigation(request)) return null
		const response = await render(request)
		return request.method === 'HEAD'
			? new Response(null, { status: response.status, headers: response.headers })
			: response
	}
	return Object.assign(fetch, { matchesRequest })
}

function isHtmlNavigation(request: Request): boolean {
	if (request.method !== 'GET' && request.method !== 'HEAD') return false
	const accept = (request.headers.get('accept') ?? '').toLowerCase()
	if (!accept.includes('text/html') && !accept.includes('*/*')) return false
	const mode = request.headers.get('sec-fetch-mode')
	if (mode && mode !== 'navigate') return false
	const destination = request.headers.get('sec-fetch-dest')
	return !destination || destination === 'document' || destination === 'iframe'
}

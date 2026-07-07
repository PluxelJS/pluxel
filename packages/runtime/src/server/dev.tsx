import { DEV_ASSETS } from './assets'
import { createHtmlResponse, renderRuntimeUiHtml } from './html'
import type { RenderHandler } from './types'

export function createDevRenderer(): RenderHandler {
	const html = renderRuntimeUiHtml(DEV_ASSETS, { target: 'vite-dev' })
	return () => createHtmlResponse(html)
}

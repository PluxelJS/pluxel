import { DEV_ASSETS } from './assets'
import { createHtmlResponse, renderRuntimeUiHtml } from './html'
import type { RenderHandler } from './types'

export function createDevRenderer(options?: { uiBasePath?: string }): RenderHandler {
	const html = renderRuntimeUiHtml(DEV_ASSETS, {
		target: 'vite-dev',
		uiBasePath: options?.uiBasePath,
	})
	return () => createHtmlResponse(html)
}

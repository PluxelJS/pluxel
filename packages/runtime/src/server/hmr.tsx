import { resolveDevAssets } from './assets'
import { createHtmlResponse, renderRuntimeUiHtml } from './html'
import type { RenderHandler } from './types'

export function createHmrRenderer(options?: { uiBasePath?: string }): RenderHandler {
	const html = renderRuntimeUiHtml(resolveDevAssets(), {
		uiBasePath: options?.uiBasePath,
	})
	return () => createHtmlResponse(html)
}

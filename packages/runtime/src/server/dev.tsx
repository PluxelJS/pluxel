import { DEV_ASSETS } from './assets'
import { createHtmlResponse, renderUiHtmlDocument } from './html'
import type { RenderHandler } from './types'

export function createDevRenderer(): RenderHandler {
	const html = renderUiHtmlDocument(DEV_ASSETS)
	return () => createHtmlResponse(html)
}

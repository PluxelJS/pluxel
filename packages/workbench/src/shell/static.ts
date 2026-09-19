import { resolveBuiltAssets } from './assets'
import { createHtmlResponse, renderRuntimeUiHtml } from './html'
import type { RenderHandler } from './router'

export async function createStaticRenderer(options?: {
	publicDirAbs?: string
	uiBasePath?: string
}): Promise<RenderHandler> {
	const assets = await resolveBuiltAssets(options)
	const html = renderRuntimeUiHtml(assets, {
		uiBasePath: options?.uiBasePath,
		prebuiltAssets: true,
	})
	return () => createHtmlResponse(html)
}

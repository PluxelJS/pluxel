import { resolveBuiltAssets } from './assets'
import { createHtmlResponse, renderRuntimeUiHtml } from './html'
import type { RenderHandler } from './types'

async function buildStaticHtml(options?: { publicDirAbs?: string; uiBasePath?: string }) {
	return resolveBuiltAssets(options).then((assets) =>
		renderRuntimeUiHtml(assets, {
			uiBasePath: options?.uiBasePath,
			prebuiltAssets: true,
		}),
	)
}

export async function createStaticRenderer(options?: {
	publicDirAbs?: string
	uiBasePath?: string
}): Promise<RenderHandler> {
	const html = await buildStaticHtml(options)
	return () => createHtmlResponse(html)
}

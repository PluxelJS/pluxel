import { resolveBuiltAssets } from './assets'
import { createHtmlResponse, renderUiHtmlDocument } from './html'
import type { RenderHandler } from './types'

async function buildStaticHtml(options?: { publicDirAbs?: string }) {
	return resolveBuiltAssets(options).then((assets) => renderUiHtmlDocument(assets))
}

export async function createStaticRenderer(options?: {
	publicDirAbs?: string
}): Promise<RenderHandler> {
	return async () => createHtmlResponse(await buildStaticHtml(options))
}

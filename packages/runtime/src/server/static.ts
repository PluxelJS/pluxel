import { resolveBuiltAssets } from './assets'
import { createHtmlResponse, renderRuntimeUiHtml } from './html'
import type { RenderHandler } from './types'

async function buildStaticHtml(options?: { publicDirAbs?: string }) {
	return resolveBuiltAssets(options).then((assets) =>
		renderRuntimeUiHtml(assets, { target: 'static-built' }),
	)
}

export async function createStaticRenderer(options?: {
	publicDirAbs?: string
}): Promise<RenderHandler> {
	return async () => createHtmlResponse(await buildStaticHtml(options))
}

import { resolveBuiltAssets } from './assets'
import { createHtmlResponse, renderRuntimeUiHtml } from './html'
import type { RenderHandler } from './router'

export async function createStaticRenderer(options?: {
	publicDirAbs: string
	uiBasePath?: string
}): Promise<RenderHandler> {
	// Fail during construction for an invalid package, and revalidate each navigation:
	// a rebuild replaces both the manifest and the files served by the asset handler.
	await resolveBuiltAssets(options.publicDirAbs)
	return async () => {
		const assets = await resolveBuiltAssets(options.publicDirAbs)
		return createHtmlResponse(
			renderRuntimeUiHtml(assets, {
				uiBasePath: options?.uiBasePath,
				prebuiltAssets: true,
			}),
		)
	}
}

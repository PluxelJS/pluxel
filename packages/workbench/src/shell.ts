import { resolve } from 'pathe'
import { createStaticRenderer } from './shell/static'
import { createUiPublicAssetHandler, resolveDefaultUiPublicDir } from './shell/ui-public'
import { normalizeWorkbenchUiBasePath } from './shell/config'
import { createShellRouter } from './shell/router'

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
	return createShellRouter({ uiBasePath, render, assets })
}

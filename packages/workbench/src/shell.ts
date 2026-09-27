import { fileURLToPath } from 'node:url'
import { basename, dirname, resolve } from 'pathe'
import { createStaticRenderer } from './shell/static'
import { createUiPublicAssetHandler } from './shell/ui-public'
import { normalizeWorkbenchUiBasePath } from './shell/config'
import { createShellRouter } from './shell/router'

export interface WorkbenchShellOptions {
	/** Browser navigation path. Defaults to `/`. */
	readonly uiBasePath?: string
	/** Built UI directory containing `.vite/manifest.json` and `assets/`. Defaults to packaged assets. */
	readonly publicDir?: string
}

function resolveDefaultUiPublicDir(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url))
	// Source entry is src/shell.ts; published entry is dist/shell.mjs.
	return basename(moduleDir) === 'dist'
		? resolve(moduleDir, 'public')
		: resolve(moduleDir, '../public')
}

/** A borrowed fetch fallback: call after business routes. Non-shell requests return null. */
export async function createWorkbenchShellHandler(options: WorkbenchShellOptions = {}) {
	const uiBasePath = normalizeWorkbenchUiBasePath(options.uiBasePath)
	const publicDirAbs = options.publicDir ? resolve(options.publicDir) : resolveDefaultUiPublicDir()
	const assets = createUiPublicAssetHandler({ publicDirAbs })
	const render = await createStaticRenderer({ publicDirAbs, uiBasePath })
	return createShellRouter({ uiBasePath, render, assets })
}

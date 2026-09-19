import type { Context } from '@pluxel/core'
import { createWorkbenchShellHandler, type WorkbenchShellOptions } from '../shell'
import { normalizeWorkbenchUiBasePath } from './config'
import { createHtmlResponse, renderRuntimeUiHtml } from './html'
import { createShellRouter, type RenderHandler } from './router'

type ShellMount = Readonly<{
	path: string
	attachSource(entryUrl: string): () => void
}>
const mounts = new WeakMap<Context, ShellMount>()

export function workbenchShellMount(ctx: Context): string | undefined {
	return mounts.get(ctx.root)?.path
}

/** Service-owned route. Read packaged assets only when first requested, after development attachment. */
export function mountWorkbenchShell(ctx: Context, options: WorkbenchShellOptions) {
	const root = ctx.root
	if (mounts.has(root)) throw new Error('[workbench] shell is already mounted')
	const path = normalizeWorkbenchUiBasePath(options.uiBasePath)
	let source: RenderHandler | undefined
	let packaged: ReturnType<typeof createWorkbenchShellHandler> | undefined
	const staticHandler = () => (packaged ??= createWorkbenchShellHandler(options))
	const handler = createShellRouter({
		uiBasePath: path,
		render: async (request) =>
			source ? source(request) : (await (await staticHandler())(request))!,
		assets: async (request) => (source ? null : (await staticHandler())(request)),
	})
	const mounted: ShellMount = {
		path,
		attachSource(entryUrl) {
			if (source) throw new Error('[workbench] source Shell is already attached')
			const html = renderRuntimeUiHtml({ js: entryUrl, css: [], preload: [] }, { uiBasePath: path })
			const render = () => createHtmlResponse(html)
			source = render
			return () => {
				if (source === render) source = undefined
			}
		},
	}
	mounts.set(root, mounted)
	return {
		handler,
		dispose() {
			if (mounts.get(root) === mounted) mounts.delete(root)
			source = undefined
		},
	}
}

/** Only the Vite development attachment may select a source renderer. */
export function attachWorkbenchSourceShell(ctx: Context, entryUrl: string): () => void {
	const mounted = mounts.get(ctx.root)
	if (!mounted) throw new Error('[workbench] workbenchSourceShell requires workbenchHttp()')
	return mounted.attachSource(entryUrl)
}

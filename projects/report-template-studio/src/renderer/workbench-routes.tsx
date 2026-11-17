import {
	createRootRoute,
	createRoute,
	createRouter,
	defaultParseSearch,
	Outlet,
	useRouterState,
	type RouterHistory,
} from '@tanstack/react-router'
import { useContentController } from '@worksplit/react'
import { useWorkspace } from './workspace-context'
import { editorLifecycle } from './editor-lifecycle'
import { FilePane, FormPane, PreviewPane } from './panes'

export type StudioDocument = { kind: 'file' | 'form' | 'preview'; path: string }

/** The root survives file/form/preview route changes and explicitly withdraws read-only protection. */
function StudioDocumentRoot() {
	const workspace = useWorkspace()
	const href = useRouterState({ select: (state) => state.resolvedLocation?.href })
	const resource =
		href && new URL(href, 'https://studio.invalid').pathname !== '/' ? studioDocument(href) : null
	const name = resource
		? (workspace.documents.get(resource.path)?.result?.name ??
			resource.path.split('/').at(-1) ??
			resource.path)
		: undefined
	useContentController(
		resource
			? {
					...(resource.kind === 'preview'
						? { leave: null }
						: editorLifecycle(workspace, resource.path, resource.kind)),
					title: `${resource.kind === 'preview' ? '预览 · ' : ''}${resource.kind === 'file' ? name : name?.replace(/\.ts$/, '')}`,
				}
			: { leave: null },
	)
	return <Outlet />
}
const rootRoute = createRootRoute({ component: StudioDocumentRoot })
const fileRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/file',
	validateSearch: (search: Record<string, unknown>) => ({ path: resourcePath(search.path) }),
	staticData: { worksplit: { title: '文件' } },
	component: () => <FilePane path={fileRoute.useSearch().path} />,
})
const formRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/form',
	validateSearch: (search: Record<string, unknown>) => ({ entry: resourcePath(search.entry) }),
	staticData: { worksplit: { title: '表单' } },
	component: () => <FormPane entry={formRoute.useSearch().entry} />,
})
const previewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/preview',
	validateSearch: (search: Record<string, unknown>) => ({ entry: resourcePath(search.entry) }),
	staticData: { worksplit: { title: '预览' } },
	component: () => <PreviewPane entry={previewRoute.useSearch().entry} />,
})
const routeTree = rootRoute.addChildren([fileRoute, formRoute, previewRoute])

export const createStudioRouter = (history: RouterHistory) => createRouter({ routeTree, history })

function resourcePath(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!value ||
		value.startsWith('/') ||
		value.includes('\\') ||
		value.split('/').some((part) => !part || part === '.' || part === '..')
	)
		throw new Error('文档路由需要有效的项目相对路径')
	return value
}

/** Project resource projection; Worksplit remains the owner of document instances. */
export function studioDocument(href: string): StudioDocument {
	const url = new URL(href, 'https://studio.invalid')
	const search = defaultParseSearch(url.search) as Record<string, unknown>
	switch (url.pathname) {
		case '/file':
			return { kind: 'file', path: resourcePath(search.path) }
		case '/form':
			return { kind: 'form', path: resourcePath(search.entry) }
		case '/preview':
			return { kind: 'preview', path: resourcePath(search.entry) }
		default:
			throw new Error(`未知的 Studio 文档路由：${url.pathname}`)
	}
}

// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from '@tanstack/react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Route as ShellRoute } from '../src/app/router/routes/_workbench.workbench.$pluginName.$'
import { Route as StandaloneRoute } from '../src/app/router/routes/_standalone.workbench-standalone.$pluginName.$'
import {
	buildWorkbenchHref,
	getWorkbenchFrame,
	WORKBENCH_ROUTE_PREFIX,
	WORKBENCH_STANDALONE_ROUTE_PREFIX,
} from '../src/workbench/paths'

vi.mock('@mantine/core', () => ({ Stack: ({ children }: { children: ReactNode }) => children }))
vi.mock('../src/workbench/runtime', () => ({
	useResolvedWorkbenchRoute: () => ({ route: undefined, snapshot: {} }),
}))
vi.mock('../src/app/router/workbench/WorkbenchRouteRenderer', () => ({
	WorkbenchRouteRenderer: ({ displayPath }: { displayPath: string }) => <p>{displayPath}</p>,
}))

let root: Root | undefined
beforeEach(() => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	vi.stubGlobal('scrollTo', vi.fn())
})
afterEach(async () => {
	await act(async () => root?.unmount())
	root = undefined
	document.body.replaceChildren()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

it.each(
	[WORKBENCH_ROUTE_PREFIX, WORKBENCH_STANDALONE_ROUTE_PREFIX].flatMap((prefix) =>
		['/', '/__pluxel/workbench'].map((basepath) => ({ prefix, basepath })),
	),
)(
	'keeps the matched $prefix pathname under $basepath while another route is loading',
	async ({ prefix, basepath }) => {
		const target = {
			definition: {
				entry: { kind: 'package-root' as const, packageName: '@test/transition' },
				exportName: 'Transition',
			},
			variant: 'default' as const,
		}
		const href = buildWorkbenchHref(target, '/settings', getWorkbenchFrame(prefix))
		let finishLoading!: () => void
		const loading = new Promise<void>((resolve) => {
			finishLoading = resolve
		})
		const route = createRootRoute({ component: Outlet })
		const fileRoute = prefix === WORKBENCH_ROUTE_PREFIX ? ShellRoute : StandaloneRoute
		const pluginRoute = createRoute({
			getParentRoute: () => route,
			path: `${prefix}/$pluginName/$`,
			// Reparent the production hook to this isolated router without its file-route parent type.
			beforeLoad: fileRoute.options.beforeLoad as Parameters<
				typeof createRoute<unknown, typeof route, string>
			>[0]['beforeLoad'],
			component: fileRoute.options.component,
		})
		const appsRoute = createRoute({
			getParentRoute: () => route,
			path: '/apps',
			loader: () => loading,
			component: () => <p>Applications</p>,
		})
		const router = createRouter({
			routeTree: route.addChildren([pluginRoute, appsRoute]),
			history: createMemoryHistory({
				initialEntries: [basepath === '/' ? href : `${basepath}${href}`],
			}),
			basepath,
			defaultPendingMs: 60_000,
		})
		const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		const container = document.body.appendChild(document.createElement('div'))
		root = createRoot(container)
		await act(async () => {
			root!.render(<RouterProvider router={router} />)
			await router.load()
		})
		expect(container.textContent).toBe(href)
		let navigation: Promise<void> | undefined
		try {
			await act(async () => {
				navigation = router.navigate({ to: '/apps' })
				await Promise.resolve()
			})
			expect(router.state.location.pathname).toBe('/apps')
			expect(container.textContent).toBe(href)
			expect(report).not.toHaveBeenCalled()
		} finally {
			await act(async () => {
				finishLoading()
				await navigation
			})
		}
		expect(container.textContent).toBe('Applications')
		expect(report).not.toHaveBeenCalled()
	},
)

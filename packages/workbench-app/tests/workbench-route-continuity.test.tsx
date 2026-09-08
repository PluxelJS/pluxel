// @vitest-environment jsdom

import { act, useEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WorkbenchShell } from '../src/app/workbench/WorkbenchShell'
import { RouteErrorBoundary } from '../src/app/router/RouteErrorBoundary'
import { WorkspaceController } from '../src/app/workbench/store'
import { WorkspaceControllerProvider } from '../src/app/workbench/context'
import { RouterLinkAdapter } from '../src/app/router/RouterLinkAdapter'
import { useCurrentPathname } from '../src/app/router/useCurrentRoute'

const probes = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }))
const paths = [
	'/plugins/v1/package/FirstPlugin/@fixture/first',
	'/plugins/v1/package/SecondPlugin/@fixture/second',
	'/plugins/v1/package/SecondPlugin/@fixture/second/config',
	'/logs',
	'/security',
	'/',
]
const mounted: Array<ReturnType<typeof createRoot>> = []

vi.mock('@mantine/hooks', () => ({ useMediaQuery: () => false }))
vi.mock('../src/app/workbench/shell/WorkbenchUpdateStatus', () => ({
	WorkbenchUpdateStatus: () => <span>HMR 就绪</span>,
}))
vi.mock('../src/app/router/screens/RouteErrorScreen', () => ({
	RouteErrorScreen: () => <p role="alert">页面错误</p>,
}))
vi.mock('../src/workbench/runtime', () => ({ useWorkbenchNavigationRoutes: () => [] }))
vi.mock('../src/app/workbench/shell/WorkbenchShellViews', () => ({
	ActivityRail: () => (
		<nav>
			{paths.map((path) => (
				<RouterLinkAdapter key={path} to={path}>
					{path}
				</RouterLinkAdapter>
			))}
		</nav>
	),
	PluginNavigationRail: () => <input aria-label="插件搜索" />,
	RouteGroupRail: () => null,
	PluginQuickOpenAction: () => null,
	WorkbenchTopbarTools: () => null,
	WorkbenchHotkeys: () => null,
}))
vi.mock('../src/app/workbench/shell/WorkbenchDocumentRenderer', () => ({
	WorkbenchDocumentRenderer: ({ pathname }: { pathname: string }) => {
		useEffect(() => {
			probes.mount()
			return () => {
				probes.unmount()
			}
		}, [])
		return (
			<main data-document-path={pathname}>
				<input aria-label="文档状态" />
			</main>
		)
	},
}))

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
	window.scrollTo = vi.fn()
	globalThis.ResizeObserver = class {
		constructor(private readonly callback: ResizeObserverCallback) {}
		observe(target: Element) {
			this.callback(
				[{ target, contentRect: { width: 1440, height: 900 } } as ResizeObserverEntry],
				this as unknown as ResizeObserver,
			)
		}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver
})

afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
	probes.mount.mockClear()
	probes.unmount.mockClear()
})

function BrowserRouteBoundary({ children }: { children: ReactNode }) {
	const pathname = useCurrentPathname()
	return <RouteErrorBoundary pathname={pathname}>{children}</RouteErrorBoundary>
}

describe('Workbench route continuity', () => {
	it('recovers from a render error on the next route without remounting healthy routes', async () => {
		function Page() {
			const pathname = useCurrentPathname()
			if (pathname === '/broken') throw new Error('fixture route failed')
			return <input aria-label="页面状态" data-path={pathname} />
		}
		const route = createRootRoute({
			component: () => (
				<BrowserRouteBoundary>
					<Page />
				</BrowserRouteBoundary>
			),
		})
		const catchAll = createRoute({ getParentRoute: () => route, path: '$', component: () => null })
		const router = createRouter({
			routeTree: route.addChildren([catchAll]),
			history: createMemoryHistory({ initialEntries: ['/healthy'] }),
		})
		const container = document.body.appendChild(document.createElement('div'))
		const root = createRoot(container, { onCaughtError: () => undefined })
		mounted.push(root)
		const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		try {
			await act(async () => {
				root.render(<RouterProvider router={router} />)
				await router.load()
			})
			const initial = container.querySelector('input')
			expect(initial).not.toBeNull()
			await act(async () => {
				await router.navigate({ to: '/another' })
			})
			expect(container.querySelector('input')).toBe(initial)
			await act(async () => {
				await router.navigate({ to: '/broken' })
			})
			expect(container.querySelector('[role="alert"]')?.textContent).toBe('页面错误')
			expect(report).toHaveBeenCalledWith(
				'[RouteErrorBoundary] route error',
				expect.objectContaining({ path: '/broken' }),
			)
			await act(async () => {
				await router.navigate({ to: '/recovered' })
			})
			expect(container.querySelector('[role="alert"]')).toBeNull()
			const recovered = container.querySelector('input')
			expect(recovered?.dataset.path).toBe('/recovered')
			await act(async () => {
				await router.navigate({ to: '/healthy' })
			})
			expect(container.querySelector('input')).toBe(recovered)
		} finally {
			report.mockRestore()
		}
	})

	it.each(['/', '/__pluxel/workbench'])(
		'keeps the shell and editor mounted during navigation below %s',
		async (basepath) => {
			const publicPath = (path: string) => `${basepath === '/' ? '' : basepath}${path}`
			const history = createMemoryHistory({ initialEntries: [publicPath(paths[0]!)] })
			const route = createRootRoute({
				component: () => (
					<BrowserRouteBoundary>
						<WorkbenchShell />
					</BrowserRouteBoundary>
				),
			})
			const catchAll = createRoute({
				getParentRoute: () => route,
				path: '$',
				component: () => null,
			})
			const router = createRouter({ routeTree: route.addChildren([catchAll]), history, basepath })
			const workspace = new WorkspaceController(paths[0])
			const container = document.body.appendChild(document.createElement('div'))
			const root = createRoot(container)
			mounted.push(root)
			await act(async () => {
				root.render(
					<WorkspaceControllerProvider controller={workspace}>
						<RouterProvider router={router} />
					</WorkspaceControllerProvider>,
				)
				await router.load()
			})
			const shell = container.querySelector('.plx-workbench')
			const editor = container.querySelector('main')
			expect(editor).not.toBeNull()
			const initialMounts = probes.mount.mock.calls.length
			for (const path of paths.slice(1)) {
				const link = [...container.querySelectorAll<HTMLAnchorElement>('nav a')].find(
					(element) => element.textContent === path,
				)!
				expect(link.getAttribute('href')).toBe(publicPath(path))
				const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
				await act(async () => {
					link.dispatchEvent(click)
					await vi.waitFor(() => expect(router.state.location.pathname).toBe(path))
				})
				expect(click.defaultPrevented).toBe(true)
				expect(container.querySelector('.plx-workbench')).toBe(shell)
				expect(container.querySelector('main')).toBe(editor)
				expect(editor?.getAttribute('data-document-path')).toBe(path)
				expect(probes.mount).toHaveBeenCalledTimes(initialMounts)
			}
		},
	)
})

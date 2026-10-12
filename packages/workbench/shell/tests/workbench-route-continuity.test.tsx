// @vitest-environment jsdom

import { act, StrictMode, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
	useRouter,
	type AnyRouter,
} from '@tanstack/react-router'
import { Actions, DockLocation, Model } from 'flexlayout-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Workbench } from '@worksplit/react'
import { WorkspaceSession } from '../src/app/workbench/session'
import { useOptionalWorkbenchDocument } from '../src/app/workbench/document'
import { RouteErrorBoundary } from '../src/app/router/RouteErrorBoundary'
import { useCurrentPathname } from '../src/app/router/useCurrentRoute'
import { RouterLinkAdapter } from '../src/app/router/RouterLinkAdapter'
import {
	openDocument,
	prepareNativeWorkbenchDom,
	renderWorkspace,
	WorkspaceProviders,
} from './helpers/native-workbench'

const probes = vi.hoisted(() => ({
	mount: vi.fn(),
	unmount: vi.fn(),
	routers: new Map<string, AnyRouter>(),
}))
const mounted: Root[] = []
const sessions: WorkspaceSession[] = []

vi.mock('../src/app/router/screens/HomeScreen', () => ({ HomeScreen: Page }))
vi.mock('../src/app/log_viewer/LiveLog', () => ({ LiveLog: Page }))
vi.mock('../src/app/security/SecurityScreen', () => ({ SecurityScreen: Page }))
vi.mock('../src/app/workbench/WorkspaceNavigation', () => ({
	WorkspaceNavigation: () => <input aria-label="入口搜索" />,
}))
vi.mock('../src/app/router/screens/RouteErrorScreen', () => ({
	RouteErrorScreen: () => <p role="alert">页面错误</p>,
}))

function Page() {
	const pathname = useCurrentPathname()
	const router = useRouter()
	const document = useOptionalWorkbenchDocument()
	useEffect(() => {
		probes.mount(document?.id)
		if (document) probes.routers.set(document.id, router)
		return () => {
			probes.unmount(document?.id)
			if (document) probes.routers.delete(document.id)
		}
	}, [document, router])
	return (
		<main data-document-id={document?.id} data-document-path={pathname}>
			<input aria-label="文档状态" defaultValue="draft" />
			<RouterLinkAdapter to="/security?view=detail#guide">安全设置</RouterLinkAdapter>
		</main>
	)
}

beforeEach(prepareNativeWorkbenchDom)
afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount()
		for (const workspace of sessions.splice(0)) await workspace.dispose()
	})
	document.body.replaceChildren()
	window.localStorage.clear()
	window.history.replaceState(null, '', '/')
	probes.mount.mockClear()
	probes.unmount.mockClear()
	probes.routers.clear()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

function session(basepath = '/') {
	const result = new WorkspaceSession({ basepath })
	sessions.push(result)
	return result
}
function BrowserRouteBoundary({ children }: { children: ReactNode }) {
	return <RouteErrorBoundary pathname={useCurrentPathname()}>{children}</RouteErrorBoundary>
}

describe('native Workbench route continuity', () => {
	it('recovers a route error through the actual Router without remounting healthy renders', async () => {
		function TestPage() {
			const pathname = useCurrentPathname()
			if (pathname === '/broken') throw new Error('fixture route failed')
			return <input aria-label="页面状态" data-path={pathname} />
		}
		const route = createRootRoute({
			component: () => (
				<BrowserRouteBoundary>
					<TestPage />
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
		await act(async () => {
			root.render(<RouterProvider router={router} />)
			await router.load()
		})
		const initial = container.querySelector('input')
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
		expect(container.querySelector<HTMLInputElement>('input')?.dataset.path).toBe('/recovered')
	})

	it.each(['/', '/__pluxel/workbench'])(
		'uses distinct memory Routers and preserves document DOM while docking under %s',
		async (basepath) => {
			const workspace = session(basepath)
			const { container, root } = await renderWorkspace(workspace)
			mounted.push(root)
			const logs = await openDocument(workspace, '/logs?filter=error#tail')
			const logsPage = container.querySelector<HTMLElement>(`main[data-document-id="${logs}"]`)!
			const input = logsPage.querySelector('input')!
			input.value = 'unsaved log filter'
			logsPage.scrollTop = 153
			const logsRouter = probes.routers.get(logs)!
			const security = await openDocument(workspace, '/security')
			const securityRouter = probes.routers.get(security)!
			expect(securityRouter).not.toBe(logsRouter)
			expect(logsRouter.history).not.toBe(securityRouter.history)
			expect(logsRouter.state.location.search).toEqual({ filter: 'error' })
			expect(logsRouter.state.location.hash).toBe('tail')
			await act(async () => {
				await securityRouter.navigate({
					to: '/security',
					search: { view: 'audit' },
					hash: 'record',
				})
			})
			expect(logsRouter.state.location.search).toEqual({ filter: 'error' })
			expect(logsRouter.state.location.hash).toBe('tail')
			const original = workspace.workbench.getDocument(logs)!
			await act(async () => {
				await workspace.workbench.dispatch(
					Actions.moveNode(logs, original.containerId, DockLocation.RIGHT, -1),
				)
			})
			expect(container.querySelector(`main[data-document-id="${logs}"]`)).toBe(logsPage)
			expect(input.value).toBe('unsaved log filter')
			expect(logsPage.scrollTop).toBe(153)
			const model = Model.fromJson(workspace.workbench.getLayout())
			expect(model.getNodeById(logs)?.getParent()?.getId()).not.toBe(original.containerId)
			await act(async () => {
				await workspace.workbench.dispatch(Actions.addTabToNewGroup(logs, 'Diagnostics', '#3366cc'))
				await workspace.workbench.dispatch(Actions.setTabPinned(logs, true))
			})
			expect(container.querySelector(`main[data-document-id="${logs}"]`)).toBe(logsPage)
			expect(input.value).toBe('unsaved log filter')
			await act(async () => workspace.workbench.activate(logs))
			expect(workspace.workbench.getActiveDocument()?.href).toBe(
				`${basepath === '/' ? '' : basepath}/logs?filter=error#tail`,
			)
			expect(probes.mount.mock.calls.filter(([id]) => id === logs)).toHaveLength(1)
			expect(probes.unmount.mock.calls.filter(([id]) => id === logs)).toHaveLength(0)
		},
	)

	it('reuses an ordinary URL, creates a distinct explicit copy, and closes only that copy', async () => {
		const workspace = session()
		const { container, root } = await renderWorkspace(workspace)
		mounted.push(root)
		const first = await openDocument(workspace, '/logs')
		const input = container.querySelector<HTMLInputElement>(
			`main[data-document-id="${first}"] input`,
		)!
		input.value = 'first draft'
		expect(await openDocument(workspace, '/logs')).toBe(first)
		const copy = await openDocument(workspace, '/logs', true)
		expect(copy).not.toBe(first)
		const copyInput = container.querySelector<HTMLInputElement>(
			`main[data-document-id="${copy}"] input`,
		)!
		expect(copyInput).not.toBe(input)
		expect(copyInput.value).toBe('draft')
		expect(probes.routers.get(copy)).not.toBe(probes.routers.get(first))
		await act(async () => {
			const result = await workspace.workbench.close(copy)
			expect(result.status).toBe('closed')
		})
		expect(workspace.workbench.getDocuments()).toHaveLength(1)
		expect(input.value).toBe('first draft')
		expect(probes.unmount.mock.calls.filter(([id]) => id === copy)).toHaveLength(1)
		expect(probes.unmount.mock.calls.filter(([id]) => id === first)).toHaveLength(0)
	})

	it('lets only Worksplit write browser history and keeps the document URL when a Border tool is focused', async () => {
		const workspace = session('/__pluxel/workbench')
		window.history.replaceState(null, '', '/__pluxel/workbench/logs')
		const push = vi.spyOn(window.history, 'pushState')
		const { container, root } = await renderWorkspace(workspace)
		mounted.push(root)
		await act(async () => {
			await workspace.start('/__pluxel/workbench/logs')
		})
		const first = workspace.workbench.getActiveDocument()!
		const logsRouter = probes.routers.get(first.id)!
		expect(logsRouter.history.location.href).toBe('/__pluxel/workbench/logs')
		await act(async () => {
			await logsRouter.navigate({ to: '/logs', search: { filter: 'warn' }, hash: 'tail' })
		})
		expect(window.location.pathname + window.location.search + window.location.hash).toBe(
			'/__pluxel/workbench/logs?filter=warn#tail',
		)
		expect(push).toHaveBeenCalledTimes(1)
		await act(async () => workspace.workbench.activate('navigation'))
		const toolInput = container.querySelector<HTMLInputElement>('[aria-label="入口搜索"]')!
		await act(async () => toolInput.focus())
		expect(workspace.workbench.getEditingContext().focusedArea).toBe('tool')
		expect(workspace.workbench.getActiveDocument()?.id).toBe(first.id)
		expect(window.location.pathname + window.location.search + window.location.hash).toBe(
			'/__pluxel/workbench/logs?filter=warn#tail',
		)
		expect(push).toHaveBeenCalledTimes(1)
	})

	it('retains session and content across StrictMode replay, rerenders and theme changes', async () => {
		const workspace = session()
		const id = await openDocument(workspace, '/logs')
		const container = document.body.appendChild(document.createElement('div'))
		const root = createRoot(container)
		mounted.push(root)
		const view = (colorScheme: 'light' | 'dark') => (
			<StrictMode>
				<WorkspaceProviders session={workspace} colorScheme={colorScheme}>
					<Workbench workbench={workspace.workbench} />
				</WorkspaceProviders>
			</StrictMode>
		)
		await act(async () => root.render(view('light')))
		const input = container.querySelector<HTMLInputElement>(`main[data-document-id="${id}"] input`)!
		input.value = 'retained draft'
		const initialMounts = probes.mount.mock.calls.length
		const router = probes.routers.get(id)
		await act(async () => root.render(view('dark')))
		expect(container.querySelector(`main[data-document-id="${id}"] input`)).toBe(input)
		expect(input.value).toBe('retained draft')
		expect(probes.routers.get(id)).toBe(router)
		expect(probes.mount).toHaveBeenCalledTimes(initialMounts)
		expect(workspace.workbench.getDocuments()).toHaveLength(1)
	})
})

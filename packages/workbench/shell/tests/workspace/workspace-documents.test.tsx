// @vitest-environment jsdom

import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
	useRouterState,
} from '@tanstack/react-router'
import { Workbench } from '@worksplit/react'
import { Actions, DockLocation } from 'flexlayout-react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
	useDocumentWorkspace,
	useOptionalWorkbenchDocument,
} from '../../src/app/workbench/document'
import { WorkspaceSession } from '../../src/app/workbench/session'
import {
	WorkspacePersistence,
	WorkspaceRestoreError,
	WorkspaceSnapshotStorage,
	workspaceStorageKey,
} from '../../src/app/workbench/snapshot'
import {
	openDocument,
	prepareNativeWorkbenchDom,
	renderWorkspace,
} from '../fixtures/native-workbench'

vi.mock('../../src/app/log_viewer/LogsPage', () => ({ LogsPage: DocumentPage }))
vi.mock('../../src/app/log_viewer/LogPreview', () => ({ LogPreview: () => null }))
vi.mock('../../src/app/security/SecurityScreen', () => ({ SecurityScreen: DocumentPage }))
vi.mock('../../src/app/router/screens/RouteErrorScreen', () => ({
	RouteErrorScreen: () => <p role="alert">页面错误</p>,
}))
vi.mock('../../src/app/workbench/PluginNavigation', () => ({
	PluginNavigation: () => <input aria-label="Search plugins" />,
}))

function DocumentPage() {
	const content = useOptionalWorkbenchDocument()!
	const href = useRouterState({ select: (state) => state.location.href })
	useDocumentWorkspace('plugins')
	return (
		<section data-document={content.id}>
			<output>{href}</output>
			<input aria-label="Notes" defaultValue="" />
		</section>
	)
}

const basepath = '/__pluxel/workbench'
const storageKey = workspaceStorageKey(basepath)
const cleanups: Array<() => void | Promise<void>> = []

beforeEach(prepareNativeWorkbenchDom)
afterEach(async () => {
	await act(async () => {
		for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
	})
	window.history.replaceState(null, '', '/')
	localStorage.clear()
	document.body.replaceChildren()
	vi.useRealTimers()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

async function mount(
	href: string,
	{
		browser = false,
		storage,
	}: {
		browser?: boolean
		storage?: WorkspaceSnapshotStorage
	} = {},
) {
	const workspace = new WorkspaceSession({ basepath, storage })
	const { container, root } = await renderWorkspace(
		workspace,
		<>
			<WorkspacePersistence />
			<Workbench instance={workspace.workbench} />
		</>,
	)
	let closed = false
	const close = async () => {
		if (closed) return
		closed = true
		await act(async () => {
			root.unmount()
			await workspace.dispose()
		})
	}
	cleanups.push(close)
	if (browser) window.history.replaceState(null, '', href)
	await act(async () => workspace.start(href, browser))
	return { workspace, container, close }
}

function notes(container: HTMLElement, id: string): HTMLInputElement {
	const field = container.querySelector<HTMLInputElement>(`[data-document="${id}"] input`)
	if (!field) throw new Error(`Missing notes for ${id}`)
	return field
}

it('moves the current document to a new location without adding a tab or changing the URL when a tool gains focus', async () => {
	const { workspace, container } = await mount(`${basepath}/logs`, { browser: true })
	const { id } = workspace.workbench.getActiveDocument()!
	const push = vi.spyOn(window.history, 'pushState')
	const location = `${basepath}/security?view=permissions#roles`
	await act(async () =>
		workspace.documents.get(id)!.navigate!({ href: '/security?view=permissions#roles' }),
	)
	expect(
		workspace.workbench.getDocuments().map((document) => [document.id, document.href]),
	).toEqual([[id, location]])
	expect(window.location.href).toBe(new URL(location, window.location.origin).href)
	expect(push).toHaveBeenCalledOnce()

	await act(async () => {
		await workspace.showTool()
	})
	const search = container.querySelector<HTMLInputElement>('[aria-label="Search plugins"]')!
	await act(async () => search.focus())
	expect(workspace.workbench.getContext().focusedContentId).toBe('navigation')
	expect(workspace.workbench.getActiveDocument()?.id).toBe(id)
	expect(push).toHaveBeenCalledOnce()
})

it('reopens two docked documents with their own routes and titles after a browser reload', async () => {
	const start = `${basepath}/logs?filter=warning#live`
	const { workspace, container, close } = await mount(start)
	const first = workspace.workbench.getActiveDocument()!
	const original = notes(container, first.id)
	original.value = 'local editing state'
	original.closest('section')!.scrollTop = 150
	const second = await openDocument(workspace, '/security?view=audit#summary', true)
	await act(async () => {
		await workspace.workbench.dispatch(
			Actions.moveNode(first.id, first.containerId!, DockLocation.RIGHT, -1),
		)
		await workspace.workbench.dispatch(Actions.renameTab(first.id, 'Investigating alerts'))
		await workspace.workbench.dispatch(Actions.setTabPinned(first.id, true))
	})
	expect(notes(container, first.id)).toBe(original)
	expect(original.value).toBe('local editing state')
	expect(original.closest('section')?.scrollTop).toBe(150)
	expect(original.closest('section')?.querySelector('output')?.value).toBe(
		'/logs?filter=warning#live',
	)
	expect(notes(container, second).value).toBe('')
	const group = workspace.workbench.getDocument(first.id)?.containerId
	expect(group).not.toBe(first.containerId)
	window.dispatchEvent(new Event('pagehide'))
	expect(localStorage.getItem(storageKey)).not.toBeNull()
	await close()

	const restored = await mount(`${basepath}/security?view=audit#summary`)
	const documents = restored.workspace.workbench.getDocuments()
	expect(documents).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: first.id,
				href: start,
				title: 'Investigating alerts',
				containerId: group,
			}),
			expect.objectContaining({ id: second, href: `${basepath}/security?view=audit#summary` }),
		]),
	)
	expect(restored.workspace.workbench.getDocument(first.id)?.node.isPinned()).toBe(true)
	expect(notes(restored.container, first.id).value).toBe('')
	expect(localStorage.getItem(workspaceStorageKey('/'))).toBeNull()
})

it('retains a recoverable snapshot until the operator chooses to reset it', () => {
	const raw = '{unreadable layout'
	localStorage.setItem(storageKey, raw)
	const storage = new WorkspaceSnapshotStorage(storageKey)
	expect(() => new WorkspaceSession({ basepath, storage })).toThrow(WorkspaceRestoreError)
	storage.retry()
	expect(localStorage.getItem(storageKey)).toBe(raw)
	expect(storage.reset()).toBe(true)
	expect(new WorkspaceSession({ basepath, storage }).workbench.getDocuments()).toEqual([])
})

it('can retry saving the latest layout after browser storage recovers', async () => {
	let recovered = false
	const storage = new WorkspaceSnapshotStorage(storageKey, {
		getItem: (key) => localStorage.getItem(key),
		setItem(key, value) {
			if (!recovered) throw new Error('Storage unavailable')
			localStorage.setItem(key, value)
		},
		removeItem: (key) => localStorage.removeItem(key),
	})
	const { workspace, close } = await mount(`${basepath}/logs`, { storage })
	window.dispatchEvent(new Event('pagehide'))
	expect(storage.getSnapshot()).toContain('Storage unavailable')
	const second = await openDocument(workspace, '/security', true)
	recovered = true
	await act(async () => storage.retry())
	expect(storage.getSnapshot()).toBeUndefined()
	await close()
	const restored = await mount(`${basepath}/security`)
	expect(restored.workspace.workbench.getActiveDocument()?.id).toBe(second)
})
import { RouteErrorBoundary } from '../../src/app/router/RouteErrorBoundary'

it('flushes the current layout when the page is hidden and ignores writes after teardown', async () => {
	vi.useFakeTimers()
	const write = vi.spyOn(Storage.prototype, 'setItem')
	const { workspace, close } = await mount(`${basepath}/logs`)
	const second = await openDocument(workspace, '/security', true)
	await act(async () => workspace.workbench.dispatch(Actions.setTabPinned(second, true)))
	expect(write).not.toHaveBeenCalled()
	vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
	document.dispatchEvent(new Event('visibilitychange'))
	expect(write).toHaveBeenCalledExactlyOnceWith(
		storageKey,
		JSON.stringify(workspace.workbench.createSnapshot()),
	)
	await close()
	localStorage.removeItem(storageKey)
	workspace.storage.schedule()
	workspace.storage.retry()
	window.dispatchEvent(new Event('pagehide'))
	await vi.runOnlyPendingTimersAsync()
	expect(localStorage.getItem(storageKey)).toBeNull()
})

it('preserves healthy route content until a route throws and lets the next route recover', async () => {
	function Page() {
		const path = useRouterState({ select: (state) => state.location.pathname })
		return (
			<RouteErrorBoundary pathname={path}>
				<RouteContent path={path} />
			</RouteErrorBoundary>
		)
	}
	function RouteContent({ path }: { path: string }) {
		if (path === '/broken') throw new Error('Route failed')
		return <input aria-label="Notes" data-path={path} />
	}
	const route = createRootRoute({ component: Page })
	const path = createRoute({ getParentRoute: () => route, path: '$', component: () => null })
	const router = createRouter({
		routeTree: route.addChildren([path]),
		history: createMemoryHistory({ initialEntries: ['/healthy'] }),
	})
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container, { onCaughtError: () => undefined })
	cleanups.push(() => root.unmount())
	const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
	await act(async () => {
		root.render(<RouterProvider router={router} />)
		await router.load()
	})
	const initial = container.querySelector('input')
	const go = (page: string) =>
		act(async () => router.navigate({ to: '/$', params: { _splat: page } }))
	await go('another')
	expect(container.querySelector('input')).toBe(initial)
	await go('broken')
	expect(container.querySelector('[role="alert"]')?.textContent).toBe('页面错误')
	expect(report).toHaveBeenCalledWith(
		'[RouteErrorBoundary] route error',
		expect.objectContaining({ path: '/broken' }),
	)
	await go('recovered')
	expect(container.querySelector('input')?.dataset.path).toBe('/recovered')
})

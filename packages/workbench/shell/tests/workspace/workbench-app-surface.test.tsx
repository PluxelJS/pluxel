// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter, useRouterState } from '@tanstack/react-router'
import type {
	WorkbenchLayout,
	WorkbenchLayoutEntry,
	WorkbenchSessionApi,
} from '@pluxel/workbench/client'
import type { RpcStub } from 'capnweb'
import { StrictMode, act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/app'
import { useRuntimeManagementClient, type RuntimeClientBootstrap } from '../../src/runtime'
import {
	useOptionalWorkbenchDocument,
	useDocumentPlugin,
	useDocumentWorkspace,
} from '../../src/app/workbench/document'
import { useOptionalWorkspaceSession } from '../../src/app/workbench/workspaceContext'
import {
	useWorkbenchNavigation,
	type WorkbenchNavigationContextValue,
} from '../../src/app/workbench/context'
import { WorkspaceSession } from '../../src/app/workbench/session'
import { buildWorkbenchHref, parsePluginDetailHref } from '../../src/workbench/paths'
import { workspaceStorageKey } from '../../src/app/workbench/snapshot'
import { prepareNativeWorkbenchDom } from '../fixtures/native-workbench'

const fixture = vi.hoisted(() => ({
	client: {} as Record<string, unknown>,
	nodes: [] as PluginNodeAddress[],
	probes: new Map<
		string,
		{
			router: unknown
			query: unknown
			management: unknown
			workspace: WorkspaceSession | null
			navigation: WorkbenchNavigationContextValue
		}
	>(),
}))
vi.mock('../../src/runtime', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../src/runtime')>()),
	createRuntimeManagementClient: () => fixture.client,
}))
vi.mock('../../src/app/plugins/pluginOverview', () => ({
	usePluginOverview: () => ({
		hasSnapshot: true,
		overview: {
			status: {
				statuses: fixture.nodes.map((address) => ({
					address,
					lifecycleState: 'running',
					desiredState: 'running',
					availability: 'available',
					issues: [],
				})),
			},
		},
	}),
}))
vi.mock('../../src/app/home/HomeIntro', () => ({ HomeIntro: BuiltinPage }))
vi.mock('../../src/app/workbench/PluginPanelDirectory', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../src/app/workbench/PluginPanelDirectory')>()),
	PluginPanelDirectory: () => null,
}))
vi.mock('../../src/app/log_viewer/LogsPage', () => ({ LogsPage: BuiltinPage }))
vi.mock('../../src/app/log_viewer/LogPreview', () => ({ LogPreview: () => <p>Owner logs</p> }))
vi.mock('../../src/app/security/SecurityScreen', () => ({ SecurityScreen: BuiltinPage }))
vi.mock('../../src/app/security/SecurityAuditScreen', () => ({ SecurityAuditScreen: BuiltinPage }))
vi.mock('../../src/app/plugins/catalog/PluginCatalog', () => ({
	PluginCatalog: () => <p>Grouped plugin catalog</p>,
}))
vi.mock('../../src/app/plugins/detail/PluginScreen', () => ({ PluginScreen: PluginPage }))
vi.mock('../../src/app/plugin-graph/LazyPluginGraphScreen', () => ({
	LazyPluginGraphScreen: BuiltinPage,
	PluginGraphRouteScreen: BuiltinPage,
}))
vi.mock('../../src/app/workbench/shell/WorkbenchUpdateStatus', () => ({
	WorkbenchUpdateStatus: () => null,
}))

function PluginPage({ pluginRoute }: { pluginRoute: string }) {
	const router = useRouter()
	useDocumentWorkspace(
		new URLSearchParams(router.state.location.searchStr).has('entry') ? 'apps' : 'plugins',
	)
	useDocumentPlugin(parsePluginDetailHref(`/plugins/${pluginRoute}`)?.target)
	return <BuiltinPage />
}

function BuiltinPage() {
	const router = useRouter()
	const pathname = useRouterState({ select: (state) => state.location.pathname })
	const query = useQueryClient()
	const management = useRuntimeManagementClient()
	const document = useOptionalWorkbenchDocument()!
	const workspace = useOptionalWorkspaceSession()
	const navigation = useWorkbenchNavigation()
	useEffect(() => {
		fixture.probes.set(document.id, { router, query, management, workspace, navigation })
		return () => {
			fixture.probes.delete(document.id)
		}
	}, [document.id, router, query, management, workspace, navigation])
	return <input aria-label={`Page ${pathname}`} defaultValue="local draft" />
}

const roots: Root[] = []
beforeEach(() => {
	prepareNativeWorkbenchDom()
	fixture.client = {
		describe: vi.fn(async () => ({ application: { product: null } })),
		updates: { follow: vi.fn(async () => ({ [Symbol.dispose]: vi.fn() })) },
	}
})
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
	document.head.querySelector('meta[name="pluxel-workbench-ui-base-path"]')?.remove()
	window.localStorage.clear()
	window.history.replaceState(null, '', '/')
	fixture.nodes = []
	fixture.probes.clear()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

function entry(path: string, frame: 'shell' | 'standalone') {
	const node: PluginNodeAddress = {
		definition: {
			entry: { kind: 'package-root', packageName: '@test/preview' },
			exportName: 'Preview',
		},
		variant: 'default',
	}
	fixture.nodes.push(node)
	return {
		descriptor: { kind: 'view', owner: node.definition, key: 'preview' },
		target: { node, displayName: 'Preview' },
		renderer: node,
		definitionRevisions: { target: 1, renderer: 1 },
		placement: { kind: 'route', path, frame, title: 'Preview page', order: 0 },
		federatedViewUnavailable: { reason: 'failed', message: 'Preview renderer unavailable' },
	} satisfies WorkbenchLayoutEntry
}
async function mount(
	href: string,
	entries: WorkbenchLayoutEntry[] = [],
	pending?: Promise<void>,
	historyState: unknown = null,
) {
	window.history.replaceState(historyState, '', href)
	const layout = vi.fn(
		async ({ target }: { target: PluginNodeAddress | null }): Promise<WorkbenchLayout> => {
			await pending
			return {
				profile: 1,
				revision: 1,
				target: target
					? entries.find(
							(item) => pluginNodeIndexKey(item.target.node) === pluginNodeIndexKey(target),
						)!.target
					: null,
				entries: target
					? entries.filter(
							(item) => pluginNodeIndexKey(item.target.node) === pluginNodeIndexKey(target),
						)
					: entries,
			}
		},
	)
	const bootstrap = {
		kind: 'workbench',
		management: {},
		workbench: { layoutDto: layout } as unknown as RpcStub<WorkbenchSessionApi>,
	} as Extract<RuntimeClientBootstrap, { kind: 'workbench' }>
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	roots.push(root)
	const view = (colorScheme: 'light' | 'dark') => (
		<StrictMode>
			<MantineProvider env="test" forceColorScheme={colorScheme}>
				<App bootstrap={bootstrap} />
			</MantineProvider>
		</StrictMode>
	)
	await act(async () => root.render(view('light')))
	return { root, container, layout, view }
}

describe('authenticated App surface ownership', () => {
	it('waits for native startup before reconciling restored panel visibility', async () => {
		const seed = new WorkspaceSession()
		const seeded = await seed.start('/logs', false)
		expect(seeded.status).toBe('applied')
		const snapshot = structuredClone(seed.workbench.createSnapshot())
		await seed.dispose()
		snapshot.layout.borders!.find((border) => border.location === 'right')!.show = true
		window.localStorage.setItem(workspaceStorageKey('/'), JSON.stringify(snapshot))
		const report = vi.spyOn(WorkspaceSession.prototype, 'report').mockImplementation(() => {})
		const { container } = await mount('/logs')
		await vi.waitFor(() =>
			expect(container.querySelector('[aria-label="Page /logs"]')).not.toBeNull(),
		)
		const workspace = [...fixture.probes.values()][0]!.workspace!
		await act(async () => {
			const started = await workspace.start('/logs', false)
			expect(started.status).toBe('applied')
		})
		expect(workspace.workbench.model.getNodeById('border_right')!.toJson()).toMatchObject({
			show: false,
		})
		expect(report).not.toHaveBeenCalled()
	})

	it('uses the exact owner and compiled declaration for canonical route titles below a nested base path', async () => {
		const basepath = '/__pluxel/workbench'
		const meta = document.createElement('meta')
		meta.name = 'pluxel-workbench-ui-base-path'
		meta.content = basepath
		document.head.append(meta)
		const publication = entry('/preview/:id', 'shell')
		const conflictingOwner = {
			...publication,
			target: {
				...publication.target,
				node: {
					definition: publication.target.node.definition,
					variant: 'fork' as const,
					forkId: 'other',
				},
			},
			placement: {
				...publication.placement,
				kind: 'route' as const,
				path: '/preview/:id',
				frame: 'shell' as const,
				title: 'Other owner',
				order: 0,
			},
		}
		const href = buildWorkbenchHref(publication.target.node, '/preview/a')
		const { container } = await mount(`${basepath}${href}`, [conflictingOwner, publication])
		await vi.waitFor(() =>
			expect(container.querySelector('[role="tab"][aria-label="Preview page"]')).not.toBeNull(),
		)
		expect(container.querySelector('[role="tab"][aria-label="Other owner"]')).toBeNull()
		expect(container.textContent).toContain('Preview renderer unavailable')
		expect(container.querySelectorAll('.worksplit-workbench')).toHaveLength(1)
		expect(window.location.pathname).toBe(`${basepath}${href}`)
	})

	it('waits for committed publication before creating the workspace and its browser-history owner', async () => {
		let release!: () => void
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		const connect = vi.spyOn(WorkspaceSession.prototype, 'start')
		const read = vi.spyOn(Storage.prototype, 'getItem')
		const { container, layout } = await mount('/logs', [], pending)
		expect(container.textContent).toContain('正在准备 Workbench 入口')
		expect(container.querySelector('.worksplit-workbench')).toBeNull()
		expect(connect).not.toHaveBeenCalled()
		expect(read.mock.calls.filter(([key]) => key === workspaceStorageKey('/'))).toHaveLength(0)
		await act(async () => {
			release()
			await pending
		})
		await vi.waitFor(() =>
			expect(container.querySelector('[aria-label="Page /logs"]')).not.toBeNull(),
		)
		expect(connect).toHaveBeenCalledOnce()
		expect(layout).toHaveBeenCalledOnce()
		expect(read.mock.calls.filter(([key]) => key === workspaceStorageKey('/'))).toHaveLength(1)
	})

	it.each(['/', '/__pluxel/workbench'])(
		'renders a standalone short deep link below %s without reading an unrelated broken workspace snapshot',
		async (basepath) => {
			if (basepath !== '/') {
				const meta = document.createElement('meta')
				meta.name = 'pluxel-workbench-ui-base-path'
				meta.content = basepath
				document.head.append(meta)
			}
			const key = workspaceStorageKey(basepath)
			const corrupt = '{broken workspace snapshot'
			window.localStorage.setItem(key, corrupt)
			const read = vi.spyOn(Storage.prototype, 'getItem')
			const connect = vi.spyOn(WorkspaceSession.prototype, 'start')
			const { container, root, view } = await mount(
				`${basepath === '/' ? '' : basepath}/preview/a`,
				[entry('/preview/:id', 'standalone')],
			)
			await vi.waitFor(() =>
				expect(container.textContent).toContain('Preview renderer unavailable'),
			)
			expect(container.querySelector('.worksplit-workbench')).toBeNull()
			expect(container.textContent).not.toContain('工作区无法恢复')
			expect(connect).not.toHaveBeenCalled()
			expect(read.mock.calls.filter(([candidate]) => candidate === key)).toHaveLength(0)
			await act(async () => root.render(view('dark')))
			expect(container.textContent).toContain('Preview renderer unavailable')
			expect(window.localStorage.getItem(key)).toBe(corrupt)
		},
	)

	it('shows recovery for a corrupt snapshot and preserves it when explicit reset fails', async () => {
		const key = workspaceStorageKey('/')
		const corrupt = '{bad native snapshot'
		window.localStorage.setItem(key, corrupt)
		const connect = vi.spyOn(WorkspaceSession.prototype, 'start')
		const { container } = await mount('/logs')
		await vi.waitFor(() => expect(container.textContent).toContain('工作区无法恢复'))
		expect(container.textContent).toContain('保留现场并重试')
		expect(window.localStorage.getItem(key)).toBe(corrupt)
		expect(container.querySelector('.worksplit-workbench')).toBeNull()
		expect(connect).not.toHaveBeenCalled()

		vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
			throw new Error('storage removal denied')
		})
		const reset = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
			(button) => button.textContent === '删除保存的布局并重新打开',
		)!
		await act(async () => reset.click())
		expect(container.textContent).toContain('storage removal denied')
		expect(window.localStorage.getItem(key)).toBe(corrupt)
		expect(connect).not.toHaveBeenCalled()
	})

	it.each(['/', '/__pluxel/workbench'])(
		'preserves an unknown deep link below %s as an explicit unavailable document',
		async (basepath) => {
			if (basepath !== '/') {
				const meta = document.createElement('meta')
				meta.name = 'pluxel-workbench-ui-base-path'
				meta.content = basepath
				document.head.append(meta)
			}
			const href = `${basepath === '/' ? '' : basepath}/missing/removed?query=value#section`
			const { container } = await mount(href)
			await vi.waitFor(() => expect(container.textContent).toContain('页面不存在'))
			expect(container.textContent).toContain('未找到路由：/missing/removed')
			expect(window.location.pathname + window.location.search + window.location.hash).toBe(href)
			expect(container.querySelectorAll('.worksplit-workbench')).toHaveLength(1)
			expect(container.querySelector('[aria-label="Page /"]')).toBeNull()
		},
	)

	// This scenario crosses several complete document navigations and layout transitions.
	it('assigns custom publication routes to the application workspace and restores the previous document', async () => {
		const publication = entry('/preview/:id', 'shell')
		const { container } = await mount('/security', [publication])
		await vi.waitFor(() => expect(fixture.probes.size).toBe(1))
		const probe = [...fixture.probes.values()][0]!
		const workspace = probe.workspace!
		const security = workspace.workbench.getActiveDocument()!
		await act(async () => probe.navigation.openTab({ path: '/preview/one', title: 'Preview page' }))
		await vi.waitFor(() => expect(workspace.activeWorkspace()).toBe('apps'))
		expect(workspace.isToolVisible('navigation')).toBe(false)
		await act(async () => workspace.workbench.activate(security.id))
		expect(workspace.activeWorkspace()).toBeUndefined()
		expect(
			workspace.workbench.model.toJson().borders?.find((border) => border.location === 'left')
				?.show,
		).toBe(false)
		expect(container.querySelector('[aria-label="Page /security"]')).not.toBeNull()
		expect(workspace.workbench.getActiveDocument()?.id).toBe(security.id)
	})

	it('shares service Providers across documents and keeps their owners across a theme rerender', async () => {
		const connect = vi.spyOn(WorkspaceSession.prototype, 'start')
		const { container, root, view } = await mount('/logs')
		await vi.waitFor(() =>
			expect(container.querySelector('[aria-label="Page /logs"]')).not.toBeNull(),
		)
		const input = container.querySelector<HTMLInputElement>('[aria-label="Page /logs"]')!
		input.value = 'retained log draft'
		const log = [...fixture.probes.values()][0]!
		await act(async () => log.navigation.openTab({ path: '/security', title: 'Security' }))
		await vi.waitFor(() =>
			expect(container.querySelector('[aria-label="Page /security"]')).not.toBeNull(),
		)
		const security = [...fixture.probes.values()].find((probe) => probe.router !== log.router)!
		expect(security.query).toBe(log.query)
		expect(security.management).toBe(log.management)
		await act(async () => root.render(view('dark')))
		expect(container.querySelector('[aria-label="Page /logs"]')).toBe(input)
		expect(input.value).toBe('retained log draft')
		expect(connect).toHaveBeenCalledOnce()
		expect(window.location.pathname).toBe('/security')
	})
})

// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { WorkbenchInstance } from '@worksplit/react'
import type {
	WorkbenchLayout,
	WorkbenchLayoutEntry,
	WorkbenchSessionApi,
} from '@pluxel/workbench/client'
import type { RpcStub } from 'capnweb'
import { Actions, DockLocation, Model, TabNode } from 'flexlayout-react'
import { StrictMode, act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/app'
import { useRuntimeManagementClient, type RuntimeClientBootstrap } from '../src/runtime'
import {
	useOptionalWorkbenchDocument,
	useDocumentPlugin,
	useDocumentWorkspace,
} from '../src/app/workbench/document'
import { useOptionalWorkspaceSession } from '../src/app/workbench/workspaceContext'
import {
	useWorkbenchNavigation,
	type WorkbenchNavigationContextValue,
} from '../src/app/workbench/context'
import { type WorkspaceSession } from '../src/app/workbench/session'
import {
	buildPluginDetailHref,
	buildWorkbenchHref,
	parsePluginDetailHref,
} from '../src/workbench/paths'
import { workspaceStorageKey } from '../src/app/workbench/snapshot'
import { prepareNativeWorkbenchDom } from './helpers/native-workbench'

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
vi.mock('../src/runtime', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/runtime')>()),
	createRuntimeManagementClient: () => fixture.client,
}))
vi.mock('../src/app/plugins/pluginOverview', () => ({
	usePluginOverview: () => ({
		hasSnapshot: true,
		overview: {
			status: {
				statuses: fixture.nodes.map((address) => ({ address, lifecycleState: 'running' })),
			},
		},
	}),
}))
vi.mock('../src/app/router/screens/HomeScreen', () => ({ HomeScreen: BuiltinPage }))
vi.mock('../src/app/workbench/PluginPanelDirectory', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/app/workbench/PluginPanelDirectory')>()),
	PluginPanelDirectory: () => null,
}))
vi.mock('../src/app/log_viewer/LogsPage', () => ({ LogsPage: BuiltinPage }))
vi.mock('../src/app/log_viewer/LogPreview', () => ({ LogPreview: () => <p>Owner logs</p> }))
vi.mock('../src/app/security/SecurityScreen', () => ({ SecurityScreen: BuiltinPage }))
vi.mock('../src/app/security/SecurityAuditScreen', () => ({ SecurityAuditScreen: BuiltinPage }))
vi.mock('../src/app/plugins/catalog/PluginCatalog', () => ({
	PluginCatalog: () => <p>Grouped plugin catalog</p>,
}))
vi.mock('../src/app/plugins/detail/PluginScreen', () => ({ PluginScreen: PluginPage }))
vi.mock('../src/app/plugin-graph/LazyPluginGraphScreen', () => ({
	LazyPluginGraphScreen: BuiltinPage,
	PluginGraphRouteScreen: BuiltinPage,
}))
vi.mock('../src/app/workbench/shell/WorkbenchUpdateStatus', () => ({
	WorkbenchUpdateStatus: () => null,
}))

function PluginPage({ pluginRoute }: { pluginRoute: string }) {
	const router = useRouter()
	useDocumentWorkspace(
		new URLSearchParams(router.state.location.searchStr).has('entry') ? 'apps' : 'plugins',
	)
	useDocumentPlugin(parsePluginDetailHref(`/plugins/${pluginRoute}`)!.target)
	return <BuiltinPage />
}

function BuiltinPage() {
	const router = useRouter()
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
	return <input aria-label={`Page ${router.state.location.pathname}`} defaultValue="local draft" />
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

function entry(path: string, frame: 'shell' | 'standalone'): WorkbenchLayoutEntry {
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
	}
}
async function mount(href: string, entries: WorkbenchLayoutEntry[] = [], pending?: Promise<void>) {
	window.history.replaceState(null, '', href)
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
	it.each([true, false])(
		'uses a committed tab label or key on the initial deep link: labeled=%s',
		async (labeled) => {
			const route = entry('/preview/:id', 'shell')
			const publication = {
				...route,
				placement: { kind: 'tab' as const, ...(labeled ? { label: 'Accounts' } : {}), order: 0 },
			}
			const { container } = await mount(
				`${buildPluginDetailHref(publication.target.node)}?entry=preview`,
				[publication],
			)
			await vi.waitFor(() =>
				expect(
					container.querySelector(`[role="tab"][aria-label="${labeled ? 'Accounts' : 'preview'}"]`),
				).not.toBeNull(),
			)
		},
	)

	it.each(['/', '/__pluxel/workbench'])(
		'uses committed tab labels and keys for ordinary opening below %s while retaining native names on reuse and refresh',
		async (basepath) => {
			if (basepath !== '/') {
				const meta = document.createElement('meta')
				meta.name = 'pluxel-workbench-ui-base-path'
				meta.content = basepath
				document.head.append(meta)
			}
			const route = entry('/preview/:id', 'shell')
			const labeled = { ...route, placement: { kind: 'tab' as const, label: 'Accounts', order: 0 } }
			const fallback = {
				...labeled,
				descriptor: { ...labeled.descriptor, key: 'diagnostics' },
				placement: { kind: 'tab' as const, order: 1 },
			}
			const prefix = basepath === '/' ? '' : basepath
			const { container, root } = await mount(`${prefix}/logs`, [labeled, fallback])
			await vi.waitFor(() => expect(fixture.probes.size).toBe(1))
			const probe = [...fixture.probes.values()][0]!
			const workspace = probe.workspace!
			await act(async () => {
				container.querySelector<HTMLButtonElement>('[aria-label="查找所有工作区入口"]')!.click()
			})
			const href = `${buildPluginDetailHref(labeled.target.node)}?entry=preview`
			const button = [
				...document.querySelectorAll<HTMLButtonElement>('.plx-workspace-navigation__link'),
			].find((candidate) => candidate.textContent?.includes('Accounts'))!
			await act(async () => button.click())
			await vi.waitFor(() =>
				expect(workspace.workbench.getActiveDocument()?.title).toBe('Accounts'),
			)
			const id = workspace.workbench.getActiveDocument()!.id
			await act(async () => {
				await workspace.workbench.dispatch(Actions.renameTab(id, 'Research notes'))
				probe.navigation.navigate(`${href}&tab=config#form`)
			})
			await vi.waitFor(() => expect(window.location.hash).toBe('#form'))
			expect(workspace.workbench.getActiveDocument()).toMatchObject({ id, title: 'Research notes' })
			expect(workspace.workbench.getDocuments()).toHaveLength(1)
			workspace.documents.get(id)!.remoteDirty = true
			const refuseLeave = vi
				.spyOn(workspace.documents.get(id)!, 'beforeLeave')
				.mockResolvedValue(false)
			await act(async () => {
				probe.navigation.navigate(`${buildPluginDetailHref(labeled.target.node)}?entry=diagnostics`)
			})
			expect(refuseLeave).toHaveBeenCalled()
			expect(workspace.workbench.getActiveDocument()).toMatchObject({ id, title: 'Research notes' })
			expect(workspace.workbench.getActiveDocument()?.href).toContain('entry=preview')
			refuseLeave.mockRestore()
			workspace.documents.get(id)!.remoteDirty = false
			await act(async () =>
				probe.navigation.openTab({
					path: `${buildPluginDetailHref(labeled.target.node)}?entry=diagnostics`,
				}),
			)
			await vi.waitFor(() =>
				expect(workspace.workbench.getActiveDocument()?.title).toBe('diagnostics'),
			)
			await act(async () => workspace.workbench.activate(id))
			await vi.waitFor(() => expect(workspace.workbench.getActiveDocument()?.id).toBe(id))
			expect(workspace.workbench.getActiveDocument()?.title).toBe('Research notes')
			const snapshot = workspace.workbench.snapshot()
			await act(async () => root.unmount())
			roots.splice(roots.indexOf(root), 1)
			window.localStorage.setItem(workspaceStorageKey(basepath), JSON.stringify(snapshot))
			const restored = await mount(`${prefix}${href}`, [labeled, fallback])
			await vi.waitFor(() =>
				expect(
					restored.container.querySelector('[role="tab"][aria-label="Research notes"]'),
				).not.toBeNull(),
			)
			expect(restored.container.querySelector('[role="tab"][aria-label="Accounts"]')).toBeNull()
		},
	)

	it.each(['/', '/__pluxel/workbench'])(
		'uses the exact owner and compiled declaration for canonical route titles below %s',
		async (basepath) => {
			if (basepath !== '/') {
				const meta = document.createElement('meta')
				meta.name = 'pluxel-workbench-ui-base-path'
				meta.content = basepath
				document.head.append(meta)
			}
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
			const { container } = await mount(`${basepath === '/' ? '' : basepath}${href}`, [
				conflictingOwner,
				publication,
			])
			await vi.waitFor(() =>
				expect(container.querySelector('[role="tab"][aria-label="Preview page"]')).not.toBeNull(),
			)
			expect(container.querySelector('[role="tab"][aria-label="Other owner"]')).toBeNull()
			expect(window.location.pathname).toBe(`${basepath === '/' ? '' : basepath}${href}`)
		},
	)

	it.each([true, false])(
		'uses an authoritative plugin detail label only when its canonical owner is published: %s',
		async (published) => {
			const publication = entry('/preview/:id', 'shell')
			const target = published
				? publication.target.node
				: {
						definition: publication.target.node.definition,
						variant: 'fork' as const,
						forkId: 'unpublished',
					}
			const { container } = await mount(buildPluginDetailHref(target), [publication])
			await vi.waitFor(() =>
				expect(
					container.querySelector(
						`[role="tab"][aria-label="${published ? 'Preview' : '插件详情'}"]`,
					),
				).not.toBeNull(),
			)
		},
	)

	it('waits for committed publication before creating the workspace and its browser-history owner', async () => {
		let release!: () => void
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		const connect = vi.spyOn(WorkbenchInstance.prototype, 'connectBrowser')
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
			const connect = vi.spyOn(WorkbenchInstance.prototype, 'connectBrowser')
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

	it.each(['declared shell', 'canonical shell', 'canonical standalone'])(
		'classifies %s against publication before acquiring its browser owner',
		async (mode) => {
			const frame = mode.endsWith('standalone') ? 'standalone' : 'shell'
			const publication = entry('/preview/:id', frame)
			const href = mode.startsWith('canonical')
				? buildWorkbenchHref(publication.target.node, '/preview/a', frame)
				: '/preview/a'
			const key = workspaceStorageKey('/')
			const read = vi.spyOn(Storage.prototype, 'getItem')
			const connect = vi.spyOn(WorkbenchInstance.prototype, 'connectBrowser')
			const { container } = await mount(href, [publication])
			await vi.waitFor(() =>
				expect(container.textContent).toContain('Preview renderer unavailable'),
			)
			expect(Boolean(container.querySelector('.worksplit-workbench'))).toBe(frame === 'shell')
			expect(connect).toHaveBeenCalledTimes(frame === 'shell' ? 1 : 0)
			expect(read.mock.calls.filter(([candidate]) => candidate === key)).toHaveLength(
				frame === 'shell' ? 1 : 0,
			)
			expect(window.location.pathname).toBe(href)
		},
	)

	it('keeps a broken snapshot intact in an explicit recovery screen and creates no history owner', async () => {
		const key = workspaceStorageKey('/')
		const corrupt = '{bad native snapshot'
		window.localStorage.setItem(key, corrupt)
		const connect = vi.spyOn(WorkbenchInstance.prototype, 'connectBrowser')
		const { container } = await mount('/logs')
		await vi.waitFor(() => expect(container.textContent).toContain('工作区无法恢复'))
		expect(container.textContent).toContain('保留现场并重试')
		expect(container.textContent).toContain('删除保存的布局并重新打开')
		expect(window.localStorage.getItem(key)).toBe(corrupt)
		expect(container.querySelector('.worksplit-workbench')).toBeNull()
		expect(connect).not.toHaveBeenCalled()
	})

	it('shows a failed explicit reset in the recovery screen and preserves the bad snapshot for another attempt', async () => {
		const key = workspaceStorageKey('/')
		const corrupt = '{bad native snapshot'
		window.localStorage.setItem(key, corrupt)
		vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
			throw new Error('storage removal denied')
		})
		const { container } = await mount('/logs')
		await vi.waitFor(() => expect(container.textContent).toContain('工作区无法恢复'))
		const reset = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
			(button) => button.textContent === '删除保存的布局并重新打开',
		)!
		await act(async () => reset.click())
		expect(container.textContent).toContain('storage removal denied')
		expect(window.localStorage.getItem(key)).toBe(corrupt)
		expect(container.querySelector('.worksplit-workbench')).toBeNull()
	})

	it.each(['/', '/logs', '/security', '/security/audit', '/plugin-graph'])(
		'keeps the builtin %s available through its real document Router',
		async (href) => {
			const { container } = await mount(href)
			await vi.waitFor(() =>
				expect(container.querySelector(`[aria-label="Page ${href}"]`)).not.toBeNull(),
			)
			expect(container.querySelectorAll('.worksplit-workbench')).toHaveLength(1)
			expect(fixture.probes.size).toBe(1)
		},
	)

	it('keeps one grouped plugin catalog beside the plugin selection document', async () => {
		const { container } = await mount('/plugins')
		await vi.waitFor(() => expect(container.textContent).toContain('选择插件'))
		expect(container.textContent?.match(/Grouped plugin catalog/g)).toHaveLength(1)
		expect(container.querySelectorAll('.worksplit-workbench')).toHaveLength(1)
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

	it('enters applications from the home menu and treats an explicit plugin shortcut as an expansion request', async () => {
		const { container } = await mount('/')
		await vi.waitFor(() => expect(fixture.probes.size).toBe(1))
		const workspace = [...fixture.probes.values()][0]!.workspace!
		const menu = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
			(button) => button.textContent?.trim() === '工作区',
		)!
		await act(async () => menu.click())
		let pages: HTMLElement | undefined
		await vi.waitFor(() => {
			pages = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
				item.textContent?.includes('显示应用目录'),
			)
			expect(pages).toBeDefined()
		})
		await act(async () => pages!.click())
		await vi.waitFor(() => expect(workspace.workbench.getActiveDocument()?.href).toBe('/apps'))
		expect(workspace.isToolVisible('navigation')).toBe(false)
		await act(async () =>
			container.querySelector<HTMLButtonElement>('.plx-activity [aria-label="首页"]')!.click(),
		)
		await vi.waitFor(() => expect(workspace.workbench.getActiveDocument()?.href).toBe('/'))
		await act(async () =>
			container.querySelector<HTMLButtonElement>('.plx-activity [aria-label="插件管理"]')!.click(),
		)
		await vi.waitFor(() => expect(workspace.workbench.getActiveDocument()?.href).toBe('/plugins'))
		expect(workspace.isToolVisible('navigation')).toBe(true)
		expect(container.textContent).toContain('Grouped plugin catalog')
	})

	it('requires a plugin owner for tools and restores each manual preference across navigation', async () => {
		const { container } = await mount('/')
		await vi.waitFor(() => expect(fixture.probes.size).toBe(1))
		const probe = [...fixture.probes.values()][0]!
		const workspace = probe.workspace!
		const visible = () =>
			['navigation', 'plugin-inspector'].map((id) => workspace.isToolVisible(id))
		expect(visible()).toEqual([false, false])
		expect(container.querySelector<HTMLButtonElement>('[aria-label="右侧面板"]')?.disabled).toBe(
			true,
		)
		await act(async () =>
			container.querySelector<HTMLButtonElement>('.plx-activity [aria-label="插件管理"]')!.click(),
		)
		await vi.waitFor(() => expect(workspace.activeWorkspace()).toBe('plugins'))
		expect(workspace.workbench.getActiveDocument()?.href).toBe('/plugins')
		expect(visible()).toEqual([true, false])
		await act(async () => {
			await workspace.toggleBorder('right')
			await workspace.toggleBorder('bottom')
		})
		expect(visible()).toEqual([true, false])
		const pluginHref = '/plugins/v1/package/Preview/@test/preview'
		await act(async () => probe.navigation.navigate(pluginHref))
		const pluginDocument = workspace.workbench.getActiveDocument()!
		await act(async () => {
			await workspace.toggleBorder('right')
			await workspace.toggleBorder('bottom')
		})
		expect(visible()).toEqual([true, true])
		await act(async () => {
			await workspace.workbench.dispatch(Actions.maximizeToggle(pluginDocument.containerId))
		})
		await act(async () =>
			container
				.querySelector<HTMLButtonElement>('.plx-activity [aria-label="认证与安全"]')!
				.click(),
		)
		await vi.waitFor(() => expect(workspace.workbench.getActiveDocument()?.href).toBe('/security'))
		expect(visible()).toEqual([false, false])
		expect(
			workspace.workbench.getLayout().borders?.find((border) => border.location === 'bottom')
				?.children,
		).toEqual([])
		await act(async () => {
			await workspace.workbench.dispatch(Actions.maximizeToggle(pluginDocument.containerId))
		})
		await act(async () => probe.navigation.navigate(pluginHref))
		expect(visible()).toEqual([true, true])
		await act(async () => {
			await workspace.toggleBorder('left')
			await workspace.toggleBorder('right')
			await workspace.toggleBorder('bottom')
		})
		await act(async () =>
			container.querySelector<HTMLButtonElement>('.plx-activity [aria-label="日志"]')!.click(),
		)
		await vi.waitFor(() => expect(workspace.workbench.getActiveDocument()?.href).toBe('/logs'))
		await act(async () => probe.navigation.navigate(pluginHref))
		expect(visible()).toEqual([false, false])
		await act(async () =>
			container.querySelector<HTMLButtonElement>('.plx-activity [aria-label="插件管理"]')!.click(),
		)
		expect(visible()).toEqual([true, false])
	})

	it('declares custom publication routes as application workspaces and rejects documents in the navigation border', async () => {
		const publication = entry('/preview/:id', 'shell')
		const { container } = await mount('/security', [publication])
		await vi.waitFor(() => expect(fixture.probes.size).toBe(1))
		const probe = [...fixture.probes.values()][0]!
		const workspace = probe.workspace!
		const security = workspace.workbench.getActiveDocument()!
		await act(async () => probe.navigation.openTab({ path: '/preview/one' }))
		await vi.waitFor(() => expect(workspace.activeWorkspace()).toBe('apps'))
		expect(workspace.isToolVisible('navigation')).toBe(false)
		await act(async () => {
			expect(
				await workspace.workbench.dispatch(
					Actions.moveNode(security.id, 'border_left', DockLocation.CENTER, -1),
				),
			).toMatchObject({ status: 'rejected' })
			workspace.workbench.activate(security.id)
		})
		expect(workspace.activeWorkspace()).toBeUndefined()
		expect(
			workspace.workbench.getLayout().borders?.find((border) => border.location === 'left')?.show,
		).toBe(false)
		expect(container.querySelector('[aria-label="Page /security"]')).not.toBeNull()
		expect(workspace.workbench.getActiveDocument()?.id).toBe(security.id)
	})

	it('reuses the retained document after tool focus and rejects moving documents into tools', async () => {
		const { container } = await mount('/plugins/v1/package/Preview/@test/preview')
		await vi.waitFor(() => expect(fixture.probes.size).toBe(1))
		const workspace = [...fixture.probes.values()][0]!.workspace!
		const original = workspace.workbench.getActiveDocument()!
		await act(async () => workspace.toggleBorder('right'))
		await act(async () => {
			workspace.workbench.activate('plugin-inspector')
		})
		expect(workspace.workbench.getActiveDocument()?.id).toBe(original.id)
		await act(async () =>
			container
				.querySelector<HTMLButtonElement>('.plx-activity [aria-label="认证与安全"]')!
				.click(),
		)
		await vi.waitFor(() => expect(workspace.workbench.getActiveDocument()?.href).toBe('/security'))
		expect(workspace.workbench.getActiveDocument()).toMatchObject({
			id: original.id,
			containerId: original.containerId,
		})
		expect(workspace.workbench.getDocuments()).toHaveLength(1)
		expect(workspace.isToolVisible('plugin-inspector')).toBe(false)
		await act(async () => {
			expect(
				await workspace.workbench.dispatch(
					Actions.moveNode(original.id, 'border_bottom', DockLocation.CENTER, -1),
				),
			).toMatchObject({ status: 'rejected' })
		})
		expect(workspace.workbench.getActiveDocument()?.containerId).toBe(original.containerId)
	})

	it.each(['ordinary', 'grouped', 'pinned'] as const)(
		'opens an independent document after its captured %s anchor in the same native container',
		async (kind) => {
			await mount('/logs')
			await vi.waitFor(() => expect(fixture.probes.size).toBe(1))
			const probe = [...fixture.probes.values()][0]!
			const workspace = probe.workspace!
			const original = workspace.workbench.getActiveDocument()!
			await act(async () => probe.navigation.openTab({ path: '/security' }))
			await vi.waitFor(() => expect(workspace.workbench.getDocuments()).toHaveLength(2))
			const security = workspace.workbench.getActiveDocument()!
			await act(async () => {
				if (kind === 'grouped')
					await workspace.workbench.dispatch(Actions.addTabToNewGroup(original.id, 'Reports'))
				if (kind === 'pinned') {
					await workspace.workbench.dispatch(Actions.setTabPinned(original.id, true))
					await workspace.workbench.dispatch(Actions.setTabPinned(security.id, true))
				}
			})
			await act(async () =>
				probe.navigation.openTab({
					path: '/logs',
					title: 'New logs',
					afterDocumentId: original.id,
				}),
			)
			await vi.waitFor(() => expect(workspace.workbench.getDocuments()).toHaveLength(3))
			const copy = workspace.workbench.getActiveDocument()!
			expect(copy.id).not.toBe(original.id)
			expect(copy.containerId).toBe(original.containerId)
			const node = Model.fromJson(workspace.workbench.getLayout()).getNodeById(
				original.id,
			) as TabNode
			expect(
				node
					.getTabContainer()
					.getChildren()
					.map((child) => child.getId()),
			).toEqual(
				kind === 'pinned'
					? [original.id, security.id, copy.id]
					: [kind === 'grouped' ? node.getParent()!.getId() : original.id, copy.id, security.id],
			)
			await act(async () => probe.navigation.navigate('/security'))
			await vi.waitFor(() => expect(workspace.workbench.getActiveDocument()?.id).toBe(copy.id))
			expect(workspace.workbench.getDocuments()).toHaveLength(3)
		},
	)

	it('shares service Providers across documents and keeps their owners across a theme rerender', async () => {
		const connect = vi.spyOn(WorkbenchInstance.prototype, 'connectBrowser')
		const { container, root, view } = await mount('/logs')
		await vi.waitFor(() =>
			expect(container.querySelector('[aria-label="Page /logs"]')).not.toBeNull(),
		)
		const input = container.querySelector<HTMLInputElement>('[aria-label="Page /logs"]')!
		input.value = 'retained log draft'
		const log = [...fixture.probes.values()][0]!
		await act(async () => log.navigation.openTab({ path: '/security' }))
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

// @vitest-environment jsdom

import { Actions, DockLocation, Model, TabNode, TabSetNode } from 'flexlayout-react'
import { formatPluginNodeRoute } from '@pluxel/core'
import { act, useEffect, useState, useMemo } from 'react'
import type { Root } from 'react-dom/client'
import { useRouter, type AnyRouter } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchLayoutEntry } from '@pluxel/workbench/client'
import { RightPane } from '../src/app/plugins/detail/RightPane'
import {
	PluginScopeProvider,
	type PluginScopeContextValue,
} from '../src/app/plugins/detail/context'
import { useOptionalWorkbenchDocument, useDocumentPlugin } from '../src/app/workbench/document'
import { WorkspaceSession } from '../src/app/workbench/session'
import { parsePluginDetailHref, buildPluginDetailHref } from '../src/workbench/paths'
import {
	openDocument,
	prepareNativeWorkbenchDom,
	renderWorkspace,
} from './helpers/native-workbench'

const state = vi.hoisted(() => ({
	crashedRoute: '',
	details: false,
	entries: [] as WorkbenchLayoutEntry[],
	pages: new Map<string, { router: AnyRouter; refresh: () => void }>(),
	dependencies: vi.fn(),
	logs: vi.fn(),
}))
const mounted: Root[] = []
const workspaces: WorkspaceSession[] = []

vi.mock('../src/app/plugins/detail/PluginScreen', () => ({ PluginScreen: PluginPage }))
vi.mock('../src/app/router/screens/RouteErrorScreen', () => ({
	RouteErrorScreen: ({ onRetry }: { onRetry?: () => void }) => (
		<div role="alert">
			页面错误
			<button type="button" onClick={onRetry}>
				重试
			</button>
		</div>
	),
}))
vi.mock('../src/app/workbench/WorkspaceNavigation', () => ({ WorkspaceNavigation: () => null }))
vi.mock('../src/app/log_viewer/LiveLog', () => ({
	LiveLog: ({ owner }: { owner?: Parameters<typeof formatPluginNodeRoute>[0] }) => {
		state.logs()
		return <p data-testid="scoped-log">{owner ? formatPluginNodeRoute(owner) : '全局日志'}</p>
	},
}))
vi.mock('../src/workbench/runtime', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/workbench/runtime')>()),
	useWorkbenchTabs: () => ({ entries: state.entries, snapshot: { layout: { revision: 1 } } }),
	useWorkbenchTargetSnapshot: () => ({ layout: { entries: state.entries, revision: 1 } }),
	useWorkbenchRuntime: () => ({ runningPluginsReady: false, runningPluginKeys: new Set() }),
	useResolvedWorkbenchRoute: () => ({ route: null, snapshot: null }),
	WorkbenchEntryView: () => <input aria-label="独立插件页面" defaultValue="entry draft" />,
}))
vi.mock('../src/app/plugins/detail/controls/ActionBar', () => ({ ActionBar: () => null }))
vi.mock('../src/app/plugins/detail/cards/LogLevelsCard', () => ({
	LogLevelsCard: () => <p>日志级别</p>,
}))
vi.mock('../src/app/plugins/detail/cards/PluginRuntimeSummaryCard', () => ({
	PluginRuntimeSummaryCard: ({ status }: { status: { route: string } }) => (
		<p data-testid="scoped-info">{status.route}</p>
	),
}))
vi.mock('../src/app/plugins/detail/usePluginDetail', () => ({
	usePluginDetail: (route: string) => ({
		detail: { address: parsePluginDetailHref(`/plugins/${route}`)!.target, label: route, desc: '' },
		statusEntry: { route },
		dependencyGraph: { detail: null },
		refetch: async () => {},
	}),
}))
vi.mock('../src/app/plugins/detail/cards/PluginDependencyDetailCard', () => ({
	PluginDependencyDetailCard: () => {
		state.dependencies()
		return <p>依赖管理</p>
	},
}))
vi.mock('../src/app/router/workbench/WorkbenchRouteRenderer', () => ({
	WorkbenchRouteRenderer: () => <p>插件页面</p>,
}))
vi.mock('../src/components', () => ({
	EmptyState: ({ title, description }: { title: string; description: string }) =>
		title === '暂无可配置项' ? (
			<input aria-label="配置状态" defaultValue="config draft" />
		) : (
			<p>
				{title} {description}
			</p>
		),
	ErrorState: () => null,
}))

function PluginPage({ pluginRoute }: { pluginRoute: string }) {
	const router = useRouter()
	const document = useOptionalWorkbenchDocument()!
	const owner = useMemo(
		() => parsePluginDetailHref(`/plugins/${pluginRoute}`)!.target,
		[pluginRoute],
	)
	useDocumentPlugin(owner)
	const [, refresh] = useState(0)
	useEffect(() => {
		state.pages.set(document.id, { router, refresh: () => refresh((value) => value + 1) })
		return () => {
			state.pages.delete(document.id)
		}
	}, [document.id, router])
	if (pluginRoute === state.crashedRoute) throw new Error('fixture plugin page failed')
	if (!state.details)
		return <input aria-label="插件表单" data-owner={pluginRoute} defaultValue={pluginRoute} />
	const value: PluginScopeContextValue = {
		owner,
		pluginRoute,
		pluginLabel: owner.definition.exportName,
		description: '',
		dependencyGraph: { detail: null, isLoading: false, isStale: false },
		status: {
			execution: {
				kind: 'native',
				origin: 'fixed',
				artifact: { kind: 'application-bundle' },
				update: { kind: 'next-start' },
			},
		} as PluginScopeContextValue['status'],
		refetch: async () => {},
	}
	return (
		<PluginScopeProvider value={value}>
			<RightPane config={{ loading: false, refetch: vi.fn() }} />
		</PluginScopeProvider>
	)
}

const firstRoute = 'v1/package/FirstPlugin/@fixture/first'
const secondRoute = 'v1/package/SecondPlugin/@fixture/second'
beforeEach(prepareNativeWorkbenchDom)
afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount()
		for (const workspace of workspaces.splice(0)) await workspace.dispose()
	})
	document.body.replaceChildren()
	window.localStorage.clear()
	state.crashedRoute = ''
	state.entries = []
	state.details = false
	state.pages.clear()
	state.dependencies.mockClear()
	state.logs.mockClear()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})
async function mount() {
	const workspace = new WorkspaceSession({ basepath: '/' })
	workspaces.push(workspace)
	const { container, root } = await renderWorkspace(workspace)
	mounted.push(root)
	const content = (id: string) =>
		container.querySelector<HTMLElement>(`[data-worksplit-content="${id}"]`)!
	return { workspace, container, content }
}
describe('plugin state within native documents', () => {
	it('isolates a failed document and retries or navigates without disturbing another editor', async () => {
		const { workspace, content } = await mount()
		const first = await openDocument(workspace, `/plugins/${firstRoute}`)
		const input = content(first).querySelector('input')!
		input.value = 'unsaved healthy editor'
		const second = await openDocument(workspace, `/plugins/${secondRoute}`)
		const router = state.pages.get(second)!.router
		const report = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		state.crashedRoute = secondRoute
		await act(async () => state.pages.get(second)!.refresh())
		expect(content(second).querySelector('[role="alert"]')).not.toBeNull()
		expect(content(first).querySelector('input')).toBe(input)
		expect(input.value).toBe('unsaved healthy editor')
		state.crashedRoute = ''
		await act(async () =>
			content(second).querySelector<HTMLButtonElement>('[role="alert"] button')!.click(),
		)
		expect(content(second).querySelector('[role="alert"]')).toBeNull()
		expect(content(first).querySelector('input')).toBe(input)
		state.crashedRoute = secondRoute
		await act(async () => state.pages.get(second)!.refresh())
		await act(async () => {
			await router.navigate({ to: '/logs' })
		})
		expect(content(second).querySelector('[role="alert"]')).toBeNull()
		expect(content(first).querySelector('input')).toBe(input)
		expect(input.value).toBe('unsaved healthy editor')
		expect(report).toHaveBeenCalled()
	})

	it('keeps canonical plugins and forks in separate document owners', async () => {
		const { workspace, content } = await mount()
		const first = await openDocument(workspace, `/plugins/${firstRoute}`)
		const firstInput = content(first).querySelector('input')!
		firstInput.value = 'first draft'
		const forkRoute = formatPluginNodeRoute({
			definition: {
				entry: { kind: 'package-root', packageName: '@fixture/first' },
				exportName: 'FirstPlugin',
			},
			variant: 'fork',
			forkId: 'secondary',
		})
		const fork = await openDocument(workspace, `/plugins/${forkRoute}`)
		const second = await openDocument(workspace, `/plugins/${secondRoute}`)
		expect(new Set([first, fork, second]).size).toBe(3)
		expect(content(fork).querySelector('input')?.value).toBe(forkRoute)
		expect(content(second).querySelector('input')?.value).toBe(secondRoute)
		expect(await openDocument(workspace, `/plugins/${firstRoute}`)).toBe(first)
		expect(content(first).querySelector('input')).toBe(firstInput)
		expect(firstInput.value).toBe('first draft')
	})

	it('retains configuration draft while toggling tools and isolates an explicit copy', async () => {
		state.details = true
		const { workspace, content } = await mount()
		const first = await openDocument(workspace, `/plugins/${firstRoute}/config`)
		const input = content(first).querySelector<HTMLInputElement>('[aria-label="配置状态"]')!
		input.value = 'unsaved config state'
		await act(async () => {
			await workspace.toggleBorder('right')
			await workspace.toggleLogs()
			await workspace.toggleBorder('right')
			await workspace.toggleLogs()
		})
		expect(content(first).querySelector('[aria-label="配置状态"]')).toBe(input)
		expect(input.value).toBe('unsaved config state')
		const copy = await openDocument(workspace, `/plugins/${firstRoute}/config`, true)
		expect(content(copy).querySelector('[aria-label="配置状态"]')).not.toBe(input)
		expect(content(copy).querySelector<HTMLInputElement>('[aria-label="配置状态"]')?.value).toBe(
			'config draft',
		)
	})

	it('opens a published entry as its own URL document and reports a removed entry explicitly', async () => {
		state.details = true
		const owner = parsePluginDetailHref(`/plugins/${firstRoute}`)!.target
		state.entries = [
			{
				descriptor: { kind: 'view', owner: owner.definition, key: 'version' },
				target: { node: owner, displayName: 'FirstPlugin' },
				renderer: owner,
				definitionRevisions: { target: 1, renderer: 1 },
				placement: { kind: 'tab', label: 'Version', order: 0 },
			},
		]
		const { workspace, content } = await mount()
		const first = await openDocument(workspace, `/plugins/${firstRoute}`)
		const input = content(first).querySelector<HTMLInputElement>('[aria-label="配置状态"]')!
		input.value = 'configuration draft'
		const button = content(first).querySelector<HTMLButtonElement>(
			'[aria-label="插件页面入口"] button',
		)!
		await act(async () => {
			button.click()
			await vi.waitFor(() => expect(workspace.workbench.getDocuments()).toHaveLength(2))
		})
		const entry = workspace.workbench.getActiveDocument()!
		expect(entry.id).not.toBe(first)
		expect(entry.href).toBe(`${buildPluginDetailHref(owner)}?entry=version`)
		expect(content(entry.id).querySelector('[aria-label="独立插件页面"]')).not.toBeNull()
		expect(content(first).querySelector('[aria-label="配置状态"]')).toBe(input)
		expect(input.value).toBe('configuration draft')
		state.entries = []
		await act(async () => state.pages.get(entry.id)!.refresh())
		expect(content(entry.id).textContent).toContain('入口不可用')
		expect(content(entry.id).textContent).toContain('version')
	})

	it('opens logs below documents without redirecting new documents, and hides only logs in a shared group', async () => {
		const { workspace, container, content } = await mount()
		const first = await openDocument(workspace, `/plugins/${firstRoute}`)
		const originalContainer = workspace.workbench.getDocument(first)!.containerId
		expect(
			Model.fromJson(workspace.workbench.getLayout()).getNodeById('plugin-logs'),
		).toBeUndefined()
		await act(async () => workspace.toggleLogs())
		const model = Model.fromJson(workspace.workbench.getLayout())
		const logsNode = model.getNodeById('plugin-logs')
		expect(logsNode).toBeInstanceOf(TabNode)
		const logsContainer = (logsNode as TabNode).getTabContainer()
		expect(logsContainer).toBeInstanceOf(TabSetNode)
		expect(logsContainer.getId()).not.toBe(originalContainer)
		expect(
			workspace.workbench.getLayout().borders?.find((border) => border.location === 'bottom')?.show,
		).toBe(false)
		const second = await openDocument(workspace, `/plugins/${secondRoute}`)
		expect(workspace.workbench.getDocument(second)?.containerId).toBe(originalContainer)
		expect(workspace.isToolVisible('plugin-logs')).toBe(true)
		const input = content(second).querySelector<HTMLInputElement>('input')!
		input.value = 'document sharing the log group'
		await act(async () => {
			await workspace.workbench.dispatch(
				Actions.moveNode(second, logsContainer.getId(), DockLocation.CENTER, -1),
			)
			workspace.workbench.activate('plugin-logs')
		})
		expect(workspace.workbench.getDocument(second)?.containerId).toBe(logsContainer.getId())
		await act(async () => workspace.toggleLogs())
		expect(
			Model.fromJson(workspace.workbench.getLayout()).getNodeById('plugin-logs'),
		).toBeInstanceOf(TabNode)
		expect(workspace.isToolVisible('plugin-logs')).toBe(false)
		expect(container.querySelector('[data-testid="scoped-log"]')).toBeNull()
		expect(workspace.workbench.getDocuments().map((document) => document.id)).toEqual(
			expect.arrayContaining([first, second]),
		)
		expect(content(second).querySelector('input')).toBe(input)
		expect(input.value).toBe('document sharing the log group')
		await act(async () => workspace.toggleLogs())
		expect(workspace.isToolVisible('plugin-logs')).toBe(true)
		expect(
			(Model.fromJson(workspace.workbench.getLayout()).getNodeById('plugin-logs') as TabNode)
				.getTabContainer()
				.getId(),
		).toBe(logsContainer.getId())
		expect(content(second).querySelector('input')).toBe(input)
		expect(input.value).toBe('document sharing the log group')
	})

	it('preserves pinned logs and resized panel weights through hide and restore', async () => {
		const { workspace } = await mount()
		await openDocument(workspace, `/plugins/${firstRoute}`)
		await act(async () => workspace.toggleLogs())
		const model = Model.fromJson(workspace.workbench.getLayout())
		const logs = model.getNodeById('plugin-logs') as TabNode
		const group = logs.getTabContainer() as TabSetNode
		expect(group.getWeight()).toBe(25)
		const row = group.getParent()!
		const sibling = row.getChildren().find((node) => node !== group) as TabSetNode
		await act(async () => {
			await workspace.workbench.dispatch(
				Actions.adjustWeights(
					row.getId(),
					row.getChildren().map((node) => (node === group ? 40 : 60)),
				),
			)
			await workspace.workbench.dispatch(
				Actions.updateNodeAttributes('plugin-logs', { pinned: true }),
			)
		})
		await act(async () => workspace.toggleLogs())
		const hidden = Model.fromJson(workspace.workbench.getLayout()).getNodeById(
			'plugin-logs',
		) as TabNode
		expect(hidden.isPinned()).toBe(true)
		expect(workspace.isToolVisible('plugin-logs')).toBe(false)
		await act(async () => workspace.toggleLogs())
		const restored = Model.fromJson(workspace.workbench.getLayout())
		const restoredLog = restored.getNodeById('plugin-logs') as TabNode
		expect(restoredLog.isPinned()).toBe(true)
		expect(workspace.isToolVisible('plugin-logs')).toBe(true)
		expect((restoredLog.getTabContainer() as TabSetNode).getWeight()).toBe(40)
		expect((restored.getNodeById(sibling.getId()) as TabSetNode).getWeight()).toBe(60)
	})

	it('keeps natively closed logs absent when another plugin document becomes active', async () => {
		const { workspace, container } = await mount()
		await openDocument(workspace, `/plugins/${firstRoute}`)
		await act(async () => workspace.toggleLogs())
		expect(workspace.isToolVisible('plugin-logs')).toBe(true)
		await act(async () => {
			expect(await workspace.workbench.dispatch(Actions.deleteTab('plugin-logs'))).toEqual({
				status: 'closed',
				id: 'plugin-logs',
				cleanupErrors: [],
			})
		})
		await openDocument(workspace, `/plugins/${secondRoute}`)
		await act(async () => workspace.syncWorkspacePanels())
		expect(
			Model.fromJson(workspace.workbench.getLayout()).getNodeById('plugin-logs'),
		).toBeUndefined()
		expect(container.querySelector('[data-testid="scoped-log"]')).toBeNull()
		await act(async () => workspace.toggleLogs())
		expect(container.querySelector('[data-testid="scoped-log"]')?.textContent).toBe(secondRoute)
	})

	it('suspends centrally docked logs while a sibling document is maximized and resumes on restore', async () => {
		const { workspace, container } = await mount()
		await openDocument(workspace, `/plugins/${firstRoute}`)
		const documentContainer = workspace.workbench.getActiveDocument()!.containerId
		const logs = () => container.querySelector('[data-testid="scoped-log"]')?.textContent
		await act(async () => workspace.toggleLogs())
		await act(async () => {
			expect(
				await workspace.workbench.dispatch(
					Actions.moveNode('plugin-logs', documentContainer, DockLocation.RIGHT, -1),
				),
			).toEqual({ status: 'applied' })
		})
		expect(logs()).toBe(firstRoute)
		await act(async () => {
			expect(await workspace.workbench.dispatch(Actions.maximizeToggle(documentContainer))).toEqual(
				{ status: 'applied' },
			)
		})
		expect(logs()).toBeUndefined()
		await act(async () => {
			await workspace.workbench.dispatch(Actions.maximizeToggle(documentContainer))
		})
		expect(logs()).toBe(firstRoute)
	})

	it('follows the active plugin and fork, preserves context on tool focus, and suspends hidden logs', async () => {
		const { workspace, container, content } = await mount()
		const first = await openDocument(workspace, `/plugins/${firstRoute}`)
		const firstInput = content(first).querySelector<HTMLInputElement>('input')!
		firstInput.value = 'kept draft'
		const logs = () => container.querySelector('[data-testid="scoped-log"]')?.textContent
		const info = () => container.querySelector('[data-testid="scoped-info"]')?.textContent
		expect(logs()).toBeUndefined()
		expect(info()).toBeUndefined()
		await act(async () => {
			await workspace.toggleBorder('right')
			await workspace.toggleLogs()
		})
		expect(logs()).toBe(firstRoute)
		expect(info()).toBe(firstRoute)
		const other = await openDocument(workspace, `/plugins/${secondRoute}`)
		expect(logs()).toBe(secondRoute)
		expect(info()).toBe(secondRoute)
		await act(async () => {
			workspace.workbench.activate('plugin-logs')
		})
		expect(workspace.workbench.getActiveDocument()?.id).toBe(other)
		expect(logs()).toBe(secondRoute)
		await act(async () => {
			await workspace.toggleLogs()
		})
		expect(logs()).toBeUndefined()
		await act(async () => {
			workspace.workbench.activate(first)
		})
		expect(info()).toBe(firstRoute)
		await act(async () => {
			await workspace.toggleLogs()
		})
		expect(logs()).toBe(firstRoute)
		expect(firstInput.value).toBe('kept draft')
		const forkOwner = {
			...parsePluginDetailHref(`/plugins/${firstRoute}`)!.target,
			variant: 'fork' as const,
			forkId: 'east',
		}
		const forkRoute = formatPluginNodeRoute(forkOwner)
		await openDocument(workspace, `/plugins/${forkRoute}`)
		expect(logs()).toBe(forkRoute)
		expect(info()).toBe(forkRoute)
		await act(async () => {
			await workspace.workbench.dispatch(Actions.deleteTab('plugin-logs'))
		})
		await act(async () => {
			await workspace.toggleLogs()
		})
		expect(logs()).toBe(forkRoute)
	})
})

// @vitest-environment jsdom

import { formatPluginNodeRoute } from '@pluxel/core'
import { act, useEffect, useState } from 'react'
import type { Root } from 'react-dom/client'
import { useRouter, type AnyRouter } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchLayoutEntry } from '@pluxel/workbench/client'
import { RightPane } from '../src/app/plugins/detail/RightPane'
import {
	PluginScopeProvider,
	type PluginScopeContextValue,
} from '../src/app/plugins/detail/context'
import { useOptionalWorkbenchDocument } from '../src/app/workbench/document'
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
	LiveLog: () => {
		state.logs()
		return <p>Runtime logs</p>
	},
}))
vi.mock('../src/workbench/runtime', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/workbench/runtime')>()),
	useWorkbenchTabs: () => ({ entries: state.entries, snapshot: { layout: { revision: 1 } } }),
	useResolvedWorkbenchRoute: () => ({ route: null, snapshot: null }),
	WorkbenchEntryView: () => <input aria-label="独立插件页面" defaultValue="entry draft" />,
}))
vi.mock('../src/app/plugins/detail/controls/ActionBar', () => ({ ActionBar: () => null }))
vi.mock('../src/app/plugins/detail/cards/LogLevelsCard', () => ({
	LogLevelsCard: () => <p>日志级别</p>,
}))
vi.mock('../src/app/plugins/detail/cards/PluginRuntimeSummaryCard', () => ({
	PluginRuntimeSummaryCard: () => <p>运行概览</p>,
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
	const owner = parsePluginDetailHref(`/plugins/${pluginRoute}`)!.target
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
const selected = (element: HTMLElement) =>
	element.querySelector('[role="tab"][aria-selected="true"]')?.textContent
async function choose(element: HTMLElement, label: string) {
	const button = [...element.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
		(tab) => tab.textContent === label,
	)!
	expect(button).toBeDefined()
	await act(async () => button.click())
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

	it('retains configuration draft across local business panels and isolates an explicit copy', async () => {
		state.details = true
		const { workspace, content } = await mount()
		const first = await openDocument(workspace, `/plugins/${firstRoute}/config`)
		const input = content(first).querySelector<HTMLInputElement>('[aria-label="配置状态"]')!
		input.value = 'unsaved config state'
		await choose(content(first), '概览')
		expect(selected(content(first))).toBe('概览')
		await choose(content(first), '日志')
		expect(selected(content(first))).toBe('日志')
		await choose(content(first), '配置')
		expect(content(first).querySelector('[aria-label="配置状态"]')).toBe(input)
		expect(input.value).toBe('unsaved config state')
		const copy = await openDocument(workspace, `/plugins/${firstRoute}/config`, true)
		expect(content(copy).querySelector('[aria-label="配置状态"]')).not.toBe(input)
		expect(content(copy).querySelector<HTMLInputElement>('[aria-label="配置状态"]')?.value).toBe(
			'config draft',
		)
	})

	it('accepts explicit inspection deep links without copying the document and keeps its config input', async () => {
		state.details = true
		const { workspace, content } = await mount()
		const id = await openDocument(workspace, `/plugins/${firstRoute}/config`)
		const input = content(id).querySelector<HTMLInputElement>('[aria-label="配置状态"]')!
		input.value = 'retained config'
		const router = state.pages.get(id)!.router
		await act(async () => {
			await router.navigate({ to: `/plugins/${firstRoute}/config`, search: { tab: 'overview' } })
		})
		expect(selected(content(id))).toBe('概览')
		await act(async () => {
			await router.navigate({ to: `/plugins/${firstRoute}/config`, search: { tab: 'logs' } })
		})
		expect(selected(content(id))).toBe('日志')
		await choose(content(id), '配置')
		expect(selected(content(id))).toBe('配置')
		expect(workspace.workbench.getDocuments()).toHaveLength(1)
		expect(content(id).querySelector('[aria-label="配置状态"]')).toBe(input)
		expect(input.value).toBe('retained config')
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

	it('defers dependency and log resources until their business panel is selected', async () => {
		state.details = true
		const { workspace, content } = await mount()
		const id = await openDocument(workspace, `/plugins/${firstRoute}/config`)
		expect(state.dependencies).not.toHaveBeenCalled()
		expect(state.logs).not.toHaveBeenCalled()
		await choose(content(id), '依赖')
		expect(state.dependencies).toHaveBeenCalled()
		expect(state.logs).not.toHaveBeenCalled()
		await choose(content(id), '日志')
		expect(state.logs).toHaveBeenCalled()
	})
})

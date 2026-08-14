import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from '@tanstack/react-router'
import { createAppRouter } from '../src/app/router'
import { groupNavItems } from '../src/app/navigation/navConfig'
import { restoreWorkbenchState, WORKBENCH_STORAGE_VERSION } from '../src/app/workbench/state'
import { isPluginWorkbenchLocation, resolveWorkbenchLocation } from '../src/app/workbench/location'
import { WorkspaceController } from '../src/app/workbench/store'
import {
	compileWorkbenchRoute,
	matchWorkbenchRoute,
	workbenchRoutesOverlap,
} from '../src/workbench/routes'

vi.mock('../src/app/router/routeTree.gen', async () => {
	const { createRootRoute } = await import('@tanstack/react-router')
	return { routeTree: createRootRoute() }
})
vi.mock('../src/app/router/screens/NotFoundScreen', () => ({ NotFoundScreen: () => null }))
vi.mock('../src/app/router/screens/RouteErrorScreen', () => ({ RouteErrorScreen: () => null }))

describe('Workbench navigation groups', () => {
	it('mounts the browser router below a host-owned UI base path', () => {
		const router = createAppRouter({
			history: createMemoryHistory({ initialEntries: ['/__pluxel/workbench/logs'] }),
			uiBasePath: '/__pluxel/workbench',
		})

		expect(router.basepath).toBe('/__pluxel/workbench')
		expect(router.state.location.pathname).toBe('/logs')
		expect(router.buildLocation({ to: '/plugins' }).publicHref).toBe('/__pluxel/workbench/plugins')
		expect(isPluginWorkbenchLocation('/plugins/example')).toBe(true)
		expect(isPluginWorkbenchLocation('/plugins-extra')).toBe(false)
		expect(resolveWorkbenchLocation('/security-extra').title).toBe('security-extra')
	})

	it('collapses grouped routes into one primary section and preserves child order', () => {
		const items = groupNavItems([
			{ label: '首页', href: '/' },
			{
				label: 'Sandbox',
				href: '/workbench/Sandbox/sandbox',
				group: { id: 'bots', label: 'Bots' },
			},
			{
				label: 'Telegram',
				href: '/workbench/Telegram/settings',
				group: { id: 'bots', label: 'Bots' },
			},
			{ label: '用户', href: '/workbench/Access/access' },
		])

		expect(items).toHaveLength(3)
		expect(items[1]).toMatchObject({
			label: 'Bots',
			href: '/workbench/Sandbox/sandbox',
			children: [
				{ label: 'Sandbox', href: '/workbench/Sandbox/sandbox' },
				{ label: 'Telegram', href: '/workbench/Telegram/settings' },
			],
		})
		expect(
			groupNavItems([
				{ label: 'A', href: '/a', group: { id: 'first', label: 'Tools' } },
				{ label: 'B', href: '/b', group: { id: 'second', label: 'Tools' } },
			]),
		).toHaveLength(2)
	})
})

describe('Workbench native document tabs', () => {
	it('creates a clean navigation instance beside the active page', () => {
		const workspace = new WorkspaceController()
		const sourcePath = '/workbench/TelegramPlugin/settings'
		workspace.reconcileLocation(sourcePath)
		const sourceId = workspace.state.uiState.activeTabId
		workspace.setActiveTabState(sourceId, 'form', { account: 'draft' })
		workspace.setTabDirty(sourceId, true)

		const adjacent = workspace.createAdjacentTab()
		workspace.reconcileLocation(sourcePath)

		expect(workspace.state.uiState.tabs.map((tab) => tab.path)).toEqual([sourcePath, sourcePath])
		expect(workspace.state.uiState.activeTabId).toBe(adjacent?.instanceId)
		expect(adjacent).toMatchObject({ path: sourcePath })
		expect(adjacent?.instanceId).not.toBe(sourceId)
		expect(adjacent?.documentKey).toBeUndefined()
		expect(workspace.state.uiState.tabState[adjacent!.instanceId]).toBeUndefined()
		expect(workspace.state.dirtyTabs[adjacent!.instanceId]).toBeUndefined()

		workspace.requestNavigation('/logs')
		workspace.reconcileLocation('/logs')

		expect(workspace.state.uiState.tabs.map((tab) => tab.path)).toEqual([sourcePath, '/logs'])
		expect(workspace.state.uiState.tabState[sourceId!]).toEqual({
			form: { account: 'draft' },
		})
		expect(workspace.state.dirtyTabs[sourceId!]).toBe(true)
	})

	it('closes the final instance back to a clean home Tab', () => {
		const workspace = new WorkspaceController()
		workspace.reconcileLocation('/logs')
		const tabId = workspace.state.uiState.activeTabId
		workspace.setActiveTabState(tabId, 'filters', { level: 'error' })
		workspace.setTabDirty(tabId, true)

		const nextTab = workspace.closeTab(tabId!)

		expect(nextTab).toMatchObject({ path: '/' })
		expect(nextTab?.documentKey).toBeUndefined()
		expect(workspace.state.uiState.tabState).toEqual({})
		expect(workspace.state.dirtyTabs).toEqual({})
	})

	it('matches whole-segment route parameters and decodes their values', () => {
		const route = compileWorkbenchRoute('/accounts/:accountId')
		expect(route.identity).toBe('accounts/:')
		expect(matchWorkbenchRoute(route, '/accounts/alerts%2Dbot')).toEqual({
			accountId: 'alerts-bot',
		})
		expect(matchWorkbenchRoute(route, '/accounts')).toBeNull()
		expect(matchWorkbenchRoute(route, '/accounts/default/diagnostics')).toBeNull()
	})

	it('detects overlapping parameterized route patterns', () => {
		const account = compileWorkbenchRoute('/accounts/:accountId')
		expect(workbenchRoutesOverlap(account, compileWorkbenchRoute('/:section/settings'))).toBe(true)
		expect(workbenchRoutesOverlap(account, compileWorkbenchRoute('/projects/:projectId'))).toBe(
			false,
		)
	})

	it('deduplicates business documents by path while retaining metadata', () => {
		const workspace = new WorkspaceController()
		const path = '/workbench/KookPlugin/accounts/default'
		workspace.openTab({ path, title: 'default', meta: 'KOOK Bot' })
		workspace.openTab({ path, title: 'alerts', meta: 'Connected' })
		const instanceId = workspace.state.uiState.tabs[0]?.instanceId
		workspace.reconcileLocation(path)

		expect(workspace.state.uiState.tabs).toEqual([
			expect.objectContaining({
				documentKey: path,
				path,
				title: 'alerts',
				meta: 'Connected',
			}),
		])
		expect(workspace.state.uiState.activeTabId).toBe(instanceId)
	})

	it('does not deduplicate ordinary navigation instances by path', () => {
		const workspace = new WorkspaceController()
		workspace.reconcileLocation('/logs')
		const first = workspace.state.uiState.tabs[0]!
		workspace.createAdjacentTab()
		workspace.requestNavigation('/security')
		workspace.reconcileLocation('/security')
		workspace.setActiveTabId(first.instanceId)
		workspace.requestNavigation('/security')
		workspace.reconcileLocation('/security')

		expect(workspace.state.uiState.tabs.map((tab) => tab.path)).toEqual(['/security', '/security'])
		expect(workspace.state.uiState.tabs.every((tab) => tab.documentKey === undefined)).toBe(true)
	})

	it('preserves an explicit openTab across route reconciliation', () => {
		const workspace = new WorkspaceController()
		const managerPath = '/workbench/TelegramPlugin/settings'
		const createPath = '/workbench/TelegramPlugin/create'
		const committedPath = '/workbench/TelegramPlugin/accounts/default'
		workspace.reconcileLocation(managerPath)
		workspace.openTab({
			path: createPath,
			title: '新建 Telegram Bot',
			meta: 'Telegram',
		})
		workspace.openTab({ path: committedPath, title: 'default' })

		workspace.reconcileLocation(committedPath)

		expect(workspace.state.uiState.tabs).toEqual([
			expect.objectContaining({ path: managerPath }),
			expect.objectContaining({
				path: createPath,
				documentKey: createPath,
				title: '新建 Telegram Bot',
				meta: 'Telegram',
			}),
			expect.objectContaining({ path: committedPath, documentKey: committedPath }),
		])
		expect(workspace.state.uiState.tabs[0]?.documentKey).toBeUndefined()
	})

	it('migrates legacy document identity and section pane state into version 2', () => {
		const path = '/workbench/TelegramPlugin/accounts/default'
		const restored = restoreWorkbenchState({
			activeTabId: 'workbench:TelegramPlugin:/accounts/default',
			navigationCollapsed: false,
			sectionPanes: { plugins: { visible: false, layout: { 'plugin-rail': 20 } } },
			tabState: {
				'workbench:TelegramPlugin:/accounts/default': { form: { expanded: true } },
				orphan: { ignored: true },
			},
			tabs: [
				{
					id: 'workbench:TelegramPlugin:/accounts/default',
					path,
					title: 'default',
					kind: 'document',
				},
			],
		})

		expect(WORKBENCH_STORAGE_VERSION).toBe(2)
		expect(restored.tabs[0]).toMatchObject({
			instanceId: 'workbench:TelegramPlugin:/accounts/default',
			documentKey: path,
		})
		expect(restored.pluginPane.visible).toBe(false)
		expect(restored.tabState).not.toHaveProperty('orphan')
	})

	it('sanitizes version 2 identity instead of accepting legacy aliases or duplicate documents', () => {
		const path = '/workbench/TelegramPlugin/accounts/default'
		const restored = restoreWorkbenchState({
			version: 2,
			state: {
				activeTabId: 'tab:duplicate',
				navigationCollapsed: true,
				pluginPane: { visible: true, layout: {} },
				sectionPanes: { plugins: { visible: false } },
				tabState: {
					'tab:first': { retained: true },
					'tab:duplicate': { removed: true },
				},
				tabs: [
					{ instanceId: 'tab:first', path, title: ' first ', documentKey: path },
					{ instanceId: 'tab:duplicate', path, title: 'duplicate', documentKey: path },
					{ id: 'legacy-alias', path: '/logs', title: 'legacy alias' },
					{ instanceId: '__proto__', path: '/logs', title: 'unsafe id' },
					{ instanceId: 'invalid-path', path: 'logs', title: 'invalid path' },
				],
			},
		})

		expect(restored.tabs).toEqual([
			{ instanceId: 'tab:first', path, title: 'first', meta: undefined, documentKey: path },
		])
		expect(restored.activeTabId).toBe('tab:first')
		expect(restored.pluginPane.visible).toBe(true)
		expect(restored.tabState).toEqual({ 'tab:first': { retained: true } })
	})
})

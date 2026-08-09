import { describe, expect, it } from 'vitest'
import { groupNavItems } from '../src/app/navigation/navConfig'
import { restoreWorkbenchState, WORKBENCH_STORAGE_VERSION } from '../src/app/workbench/state'
import { isPluginWorkbenchLocation, resolveWorkbenchLocation } from '../src/app/workbench/location'
import { WorkspaceController } from '../src/app/workbench/store'
import {
	compileWorkbenchRoute,
	matchWorkbenchRoute,
	workbenchRoutesOverlap,
} from '../src/workbench/routes'

describe('Workbench navigation groups', () => {
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
	})

	it('does not merge routes from different group ids with the same label', () => {
		const items = groupNavItems([
			{ label: 'A', href: '/a', group: { id: 'first', label: 'Tools' } },
			{ label: 'B', href: '/b', group: { id: 'second', label: 'Tools' } },
		])

		expect(items).toHaveLength(2)
		expect(items.map((item) => item.children?.[0]?.href)).toEqual(['/a', '/b'])
	})
})

describe('Workbench native document tabs', () => {
	it('matches builtin section paths on whole segments only', () => {
		expect(isPluginWorkbenchLocation('/plugins/example')).toBe(true)
		expect(isPluginWorkbenchLocation('/plugins-extra')).toBe(false)
		expect(resolveWorkbenchLocation('/security-extra')).toMatchObject({
			title: 'security-extra',
		})
	})

	it('isolates workspace state per controller instance', () => {
		const first = new WorkspaceController()
		const second = new WorkspaceController()
		const path = '/workbench/KookPlugin/accounts/default'
		first.openTab({ path, title: 'default' })

		expect(first.state.uiState.tabs).toEqual([
			expect.objectContaining({ documentKey: path, path, title: 'default' }),
		])
		expect(second.state.uiState.tabs).toHaveLength(0)
	})

	it('can reconcile the initial router location before the shell renders', () => {
		const workspace = new WorkspaceController('/logs')

		expect(workspace.state.uiState.tabs).toEqual([
			expect.objectContaining({ path: '/logs', title: '日志' }),
		])
	})

	it('creates a clean navigation instance beside the active page', () => {
		const workspace = new WorkspaceController()
		const sourcePath = '/workbench/TelegramPlugin/settings'
		workspace.reconcileLocation(sourcePath)
		const sourceId = workspace.state.uiState.activeTabId
		workspace.setActiveTabState(sourceId, 'form', { account: 'draft' })
		workspace.setTabDirty(sourceId, true)

		const adjacent = workspace.createAdjacentTab()

		expect(workspace.state.uiState.tabs.map((tab) => tab.path)).toEqual([sourcePath, sourcePath])
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

	it('keeps a dirty active instance during ordinary navigation', () => {
		const workspace = new WorkspaceController()
		const sourcePath = '/workbench/TelegramPlugin/settings'
		workspace.reconcileLocation(sourcePath)
		const sourceId = workspace.state.uiState.activeTabId
		workspace.setTabDirty(sourceId, true)

		workspace.requestNavigation('/logs')
		workspace.reconcileLocation('/logs')

		expect(workspace.state.uiState.tabs.map((tab) => tab.path)).toEqual([sourcePath, '/logs'])
		expect(workspace.state.uiState.activeTabId).not.toBe(sourceId)
		expect(workspace.state.dirtyTabs[sourceId!]).toBe(true)
	})

	it('preserves a same-path instance during route reconciliation', () => {
		const workspace = new WorkspaceController()
		const path = '/workbench/TelegramPlugin/settings'
		workspace.reconcileLocation(path)
		const adjacent = workspace.createAdjacentTab()

		workspace.reconcileLocation(path)

		expect(workspace.state.uiState.activeTabId).toBe(adjacent?.instanceId)
		expect(workspace.state.uiState.tabs).toHaveLength(2)
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

		expect(workspace.state.uiState.tabs).toEqual([
			expect.objectContaining({
				documentKey: path,
				path,
				title: 'alerts',
				meta: 'Connected',
			}),
		])
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
		workspace.reconcileLocation(managerPath)
		workspace.openTab({
			path: createPath,
			title: '新建 Telegram Bot',
			meta: 'Telegram',
		})

		workspace.reconcileLocation(createPath)

		expect(workspace.state.uiState.tabs).toEqual([
			expect.objectContaining({ path: managerPath }),
			expect.objectContaining({
				path: createPath,
				documentKey: createPath,
				title: '新建 Telegram Bot',
				meta: 'Telegram',
			}),
		])
		expect(workspace.state.uiState.tabs[0]?.documentKey).toBeUndefined()
	})

	it('preserves document identity across consecutive openTab route commits', () => {
		const workspace = new WorkspaceController()
		const firstPath = '/workbench/TelegramPlugin/accounts/first'
		const secondPath = '/workbench/TelegramPlugin/accounts/second'
		workspace.reconcileLocation('/workbench/TelegramPlugin/settings')
		workspace.openTab({ path: firstPath, title: 'first' })
		workspace.openTab({ path: secondPath, title: 'second' })

		workspace.reconcileLocation(firstPath)
		expect(workspace.state.uiState.tabs.find((tab) => tab.path === firstPath)).toMatchObject({
			documentKey: firstPath,
		})

		workspace.reconcileLocation(secondPath)
		expect(workspace.state.uiState.tabs.find((tab) => tab.path === secondPath)).toMatchObject({
			documentKey: secondPath,
		})
	})

	it('focuses a restored document when the initial URL already targets it', () => {
		const firstPath = '/workbench/TelegramPlugin/accounts/first'
		const secondPath = '/workbench/TelegramPlugin/accounts/second'
		const workspace = new WorkspaceController()
		workspace.openTab({ path: firstPath, title: 'first' })
		workspace.openTab({ path: secondPath, title: 'second' })
		workspace.reconcileLocation(firstPath)
		workspace.reconcileLocation(secondPath)
		const first = workspace.state.uiState.tabs.find((tab) => tab.path === firstPath)!

		workspace.reconcileLocation(firstPath)

		expect(workspace.state.uiState.activeTabId).toBe(first.instanceId)
		expect(workspace.state.uiState.tabs.filter((tab) => tab.path === firstPath)).toHaveLength(1)
		expect(first.documentKey).toBe(firstPath)
	})

	it('consumes skipped navigation intents without corrupting the committed document', () => {
		const workspace = new WorkspaceController()
		const skippedPath = '/workbench/TelegramPlugin/accounts/skipped'
		const committedPath = '/workbench/TelegramPlugin/accounts/committed'
		workspace.reconcileLocation('/workbench/TelegramPlugin/settings')
		workspace.openTab({ path: skippedPath, title: 'skipped' })
		workspace.openTab({ path: committedPath, title: 'committed' })

		workspace.reconcileLocation(committedPath)

		expect(workspace.state.uiState.tabs.find((tab) => tab.path === committedPath)).toMatchObject({
			documentKey: committedPath,
		})
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

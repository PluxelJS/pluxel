import { describe, expect, it } from 'vitest'
import { groupNavItems } from '../src/app/navigation/navConfig'
import { createDefaultWorkbenchUiState } from '../src/app/workbench/state'
import { WorkspaceController } from '../src/app/workbench/store'
import { deriveTabFromPath, syncWorkbenchTabs } from '../src/app/workbench/tabs'
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
	it('isolates workspace state and navigation intent per controller instance', () => {
		const first = new WorkspaceController()
		const second = new WorkspaceController()
		first.openTab({ path: '/workbench/KookPlugin/accounts/default', title: 'default' })

		expect(first.state.uiState.tabs).toHaveLength(1)
		expect(second.state.uiState.tabs).toHaveLength(0)
		expect(first.consumeNavigation('/workbench/KookPlugin/accounts/default')?.mode).toBe('open-tab')
		expect(first.consumeNavigation('/workbench/KookPlugin/accounts/default')).toBeNull()
	})

	it('creates a clean navigation tab beside the active page', () => {
		const workspace = new WorkspaceController()
		const sourcePath = '/workbench/TelegramPlugin/settings'
		workspace.syncLocation(sourcePath, 'replace-active')
		const sourceId = workspace.state.uiState.activeTabId
		workspace.setActiveTabState(sourceId, 'form', { account: 'draft' })
		workspace.setTabDirty(sourceId, true)

		const duplicate = workspace.duplicateActiveTab()

		expect(workspace.state.uiState.tabs.map((tab) => tab.path)).toEqual([sourcePath, sourcePath])
		expect(duplicate).toMatchObject({
			id: 'workbench:TelegramPlugin:/settings:instance:2',
			path: sourcePath,
		})
		expect(workspace.state.uiState.tabState[duplicate!.id]).toBeUndefined()
		expect(workspace.state.dirtyTabs[duplicate!.id]).toBeUndefined()

		workspace.requestNavigation('/logs')
		const intent = workspace.consumeNavigation('/logs')
		workspace.syncLocation('/logs', intent?.mode ?? 'replace-active')

		expect(workspace.state.uiState.tabs.map((tab) => tab.path)).toEqual([sourcePath, '/logs'])
		expect(workspace.state.uiState.tabState[sourceId!]).toEqual({
			form: { account: 'draft' },
		})
		expect(workspace.state.dirtyTabs[sourceId!]).toBe(true)
	})

	it('keeps a dirty active tab during ordinary navigation', () => {
		const workspace = new WorkspaceController()
		const sourcePath = '/workbench/TelegramPlugin/settings'
		workspace.syncLocation(sourcePath, 'replace-active')
		const sourceId = workspace.state.uiState.activeTabId
		workspace.setTabDirty(sourceId, true)

		workspace.requestNavigation('/logs')
		const intent = workspace.consumeNavigation('/logs')
		workspace.syncLocation('/logs', intent?.mode ?? 'replace-active')

		expect(intent?.mode).toBe('open-tab')
		expect(workspace.state.uiState.tabs.map((tab) => tab.path)).toEqual([sourcePath, '/logs'])
		expect(workspace.state.dirtyTabs[sourceId!]).toBe(true)
	})

	it('preserves a same-path tab instance during route reconciliation', () => {
		const workspace = new WorkspaceController()
		const path = '/workbench/TelegramPlugin/settings'
		workspace.syncLocation(path, 'replace-active')
		const duplicate = workspace.duplicateActiveTab()

		workspace.syncLocation(path, 'replace-active')

		expect(workspace.state.uiState.activeTabId).toBe(duplicate?.id)
		expect(workspace.state.uiState.tabs).toHaveLength(2)
	})

	it('closes the final tab back to a clean home tab', () => {
		const workspace = new WorkspaceController()
		workspace.syncLocation('/logs', 'replace-active')
		const tabId = workspace.state.uiState.activeTabId
		workspace.setActiveTabState(tabId, 'filters', { level: 'error' })
		workspace.setTabDirty(tabId, true)

		const nextTab = workspace.closeTab(tabId!)

		expect(nextTab).toMatchObject({ id: 'home', path: '/' })
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

	it('deduplicates native tabs by path while retaining document metadata', () => {
		const path = '/workbench/KookPlugin/accounts/default'
		const document = {
			...deriveTabFromPath(path),
			title: 'default',
			meta: 'KOOK Bot',
			kind: 'document' as const,
		}
		const first = syncWorkbenchTabs(createDefaultWorkbenchUiState(), document, 'open-tab')
		const second = syncWorkbenchTabs(first, document, 'open-tab')
		expect(second.tabs).toEqual([document])
		expect(second.activeTabId).toBe(document.id)

		const renamed = { ...document, title: 'alerts', meta: 'Connected' }
		const updated = syncWorkbenchTabs(second, renamed, 'open-tab')
		expect(updated.tabs).toEqual([renamed])
	})

	it('opens a second native tab without replacing the current plugin workbench', () => {
		const first = {
			...deriveTabFromPath('/plugins/TelegramPlugin'),
			kind: 'document' as const,
		}
		const second = {
			...deriveTabFromPath('/workbench/TelegramPlugin/accounts/default'),
			title: 'default',
			meta: 'Telegram Bot',
			kind: 'document' as const,
		}
		const state = syncWorkbenchTabs(createDefaultWorkbenchUiState(), first, 'open-tab')
		const next = syncWorkbenchTabs(state, second, 'open-tab')

		expect(next.tabs.map((tab) => tab.path)).toEqual([
			'/plugins/TelegramPlugin',
			'/workbench/TelegramPlugin/accounts/default',
		])
		expect(next.activeTabId).toBe(second.id)
	})

	it('preserves an explicit openTab across the following route reconciliation', () => {
		const workspace = new WorkspaceController()
		const managerPath = '/workbench/TelegramPlugin/settings'
		const createPath = '/workbench/TelegramPlugin/create'
		workspace.syncLocation(managerPath, 'replace-active')
		workspace.openTab({
			path: createPath,
			title: '新建 Telegram Bot',
			meta: 'Telegram',
		})

		const intent = workspace.consumeNavigation(createPath)
		workspace.syncLocation(createPath, intent?.mode ?? 'replace-active')

		expect(workspace.state.uiState.tabs).toEqual([
			expect.objectContaining({ path: managerPath }),
			expect.objectContaining({
				path: createPath,
				title: '新建 Telegram Bot',
				meta: 'Telegram',
				kind: 'document',
			}),
		])
		expect(workspace.state.uiState.activeTabId).toBe('workbench:TelegramPlugin:/create')
	})
})

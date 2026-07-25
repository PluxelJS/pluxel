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
		first.queueNavigation('/workbench/KookPlugin/accounts/default', 'open-tab')

		expect(first.state.uiState.tabs).toHaveLength(1)
		expect(second.state.uiState.tabs).toHaveLength(0)
		expect(first.consumeNavigation('/workbench/KookPlugin/accounts/default')?.mode).toBe('open-tab')
		expect(first.consumeNavigation('/workbench/KookPlugin/accounts/default')).toBeNull()
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
})

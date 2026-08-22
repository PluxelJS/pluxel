import { describe, expect, it, vi } from 'vitest'
import { pluginNodeAddressEqual, type PluginNodeAddress } from '@pluxel/core'
import { createMemoryHistory } from '@tanstack/react-router'
import { createAppRouter } from '../src/app/router'
import { groupNavItems } from '../src/app/navigation/navConfig'
import { restoreWorkbenchState } from '../src/app/workbench/state'
import { isPluginWorkbenchLocation, resolveWorkbenchLocation } from '../src/app/workbench/location'
import { WorkspaceController } from '../src/app/workbench/store'
import {
	compileWorkbenchRoute,
	matchWorkbenchRoute,
	workbenchRoutesOverlap,
} from '../src/workbench/routes'
import {
	buildPluginDetailHref,
	buildWorkbenchHref,
	parsePluginDetailHref,
} from '../src/workbench/paths'

vi.mock('../src/app/router/routeTree.gen', async () => {
	const { createRootRoute } = await import('@tanstack/react-router')
	return { routeTree: createRootRoute() }
})
vi.mock('../src/app/router/screens/NotFoundScreen', () => ({ NotFoundScreen: () => null }))
vi.mock('../src/app/router/screens/RouteErrorScreen', () => ({ RouteErrorScreen: () => null }))

const OrdersTarget: PluginNodeAddress = {
	definition: {
		entry: { kind: 'source-entry', sourceSpace: 'app', path: 'plugins/orders.ts' },
		exportName: 'OrdersPlugin',
	},
	variant: 'fork',
	forkId: 'east',
}

function packageTarget(packageName: string, exportName: string): PluginNodeAddress {
	return {
		definition: { entry: { kind: 'package-root', packageName }, exportName },
		variant: 'default',
	}
}

const SandboxTarget = packageTarget('@example/sandbox', 'SandboxPlugin')
const TelegramTarget = packageTarget('@example/telegram', 'TelegramPlugin')
const AccessTarget = packageTarget('@example/access', 'AccessPlugin')
const KookTarget = packageTarget('@example/kook', 'KookPlugin')

describe('Workbench navigation groups', () => {
	it('uses canonical readable Plugin node routes for detail pages', () => {
		const href = buildPluginDetailHref(OrdersTarget, '/config')
		expect(href).toBe('/plugins/v1/fork/east/source/OrdersPlugin/app/2/plugins/orders.ts/config')

		const parsed = parsePluginDetailHref(href)
		expect(parsed?.path).toBe('/config')
		expect(parsed && pluginNodeAddressEqual(parsed.target, OrdersTarget)).toBe(true)
		expect(resolveWorkbenchLocation(href)).toMatchObject({
			title: 'OrdersPlugin',
			meta: '配置',
		})
		expect(parsePluginDetailHref('/plugins/source%3Aapp%2Forders.ts%3A%3AOrdersPlugin')).toBe(
			undefined,
		)
	})

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
		const sandboxPath = buildWorkbenchHref(SandboxTarget, '/sandbox')
		const telegramPath = buildWorkbenchHref(TelegramTarget, '/settings')
		const accessPath = buildWorkbenchHref(AccessTarget, '/access')
		const items = groupNavItems([
			{ label: '首页', href: '/' },
			{
				label: 'Sandbox',
				href: sandboxPath,
				group: { id: 'bots', label: 'Bots' },
			},
			{
				label: 'Telegram',
				href: telegramPath,
				group: { id: 'bots', label: 'Bots' },
			},
			{ label: '用户', href: accessPath },
		])

		expect(items).toHaveLength(3)
		expect(items[1]).toMatchObject({
			label: 'Bots',
			href: sandboxPath,
			children: [
				{ label: 'Sandbox', href: sandboxPath },
				{ label: 'Telegram', href: telegramPath },
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
		const sourcePath = buildWorkbenchHref(TelegramTarget, '/settings')
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
		const path = buildWorkbenchHref(KookTarget, '/accounts/default')
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
		const managerPath = buildWorkbenchHref(TelegramTarget, '/settings')
		const createPath = buildWorkbenchHref(TelegramTarget, '/create')
		const committedPath = buildWorkbenchHref(TelegramTarget, '/accounts/default')
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

	it('sanitizes version 3 identity and rejects aliases or duplicate documents', () => {
		const path = buildWorkbenchHref(TelegramTarget, '/accounts/default')
		const restored = restoreWorkbenchState({
			version: 3,
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
					{ id: 'obsolete-alias', path: '/logs', title: 'obsolete alias' },
					{ instanceId: '__proto__', path: '/logs', title: 'unsafe id' },
					{ instanceId: 'invalid-path', path: 'logs', title: 'invalid path' },
					{
						instanceId: 'invalid-workbench-path',
						path: '/workbench/TelegramPlugin/settings',
						title: 'invalid Workbench route',
					},
					{
						instanceId: 'invalid-plugin-path',
						path: '/plugins/OrdersPlugin~east',
						title: 'invalid Plugin route',
					},
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

	it.each([1, 2])('rejects unsupported persisted version %s', (version) => {
		expect(restoreWorkbenchState({ version, state: { tabs: [] } })).toEqual(
			restoreWorkbenchState(undefined),
		)
	})
})

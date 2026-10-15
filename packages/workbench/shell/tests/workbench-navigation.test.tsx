// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { formatPluginNodeRoute, type PluginNodeAddress } from '@pluxel/core'
import type { WorkbenchLayoutEntry } from '@pluxel/workbench/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchNavigationProvider } from '../src/app/workbench/context'
import { WorkspaceNavigation } from '../src/app/workbench/WorkspaceNavigation'
import {
	compileWorkbenchSnapshot,
	type WorkbenchTargetSnapshot,
} from '../src/workbench/client-snapshot'
import { buildPluginDetailHref } from '../src/workbench/paths'
import { prepareNativeWorkbenchDom } from './helpers/native-workbench'

const source = vi.hoisted(() => ({ snapshot: undefined as WorkbenchTargetSnapshot | undefined }))
vi.mock('../src/workbench/runtime', () => ({ useWorkbenchTargetSnapshot: () => source.snapshot }))
vi.mock('../src/app/plugins/pluginOverview', () => ({
	usePluginOverview: () => ({
		overview: {
			status: {
				statuses: [
					{
						address: owner,
						route: formatPluginNodeRoute(owner),
						label: 'Accounts East config',
						lifecycleState: 'running',
					},
					{
						address: { ...owner, variant: 'fork', forkId: 'west' },
						route: formatPluginNodeRoute({ ...owner, variant: 'fork', forkId: 'west' }),
						label: 'Accounts West config',
						lifecycleState: 'stopped',
					},
					{
						address: { ...owner, variant: 'fork', forkId: 'north' },
						route: formatPluginNodeRoute({ ...owner, variant: 'fork', forkId: 'north' }),
						label: 'Accounts North config',
						lifecycleState: 'running',
					},
				],
			},
		},
	}),
}))

const owner: PluginNodeAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@test/accounts' },
		exportName: 'Accounts',
	},
	variant: 'fork',
	forkId: 'east',
}
function entry(key: string, placement: WorkbenchLayoutEntry['placement']): WorkbenchLayoutEntry {
	const descriptor = { kind: 'view' as const, owner: owner.definition, key }
	return {
		descriptor,
		target: { node: owner, displayName: 'Accounts East' },
		renderer: owner,
		definitionRevisions: { target: 1, renderer: 1 },
		placement,
		federatedViewRef: {
			profile: 1,
			producer: 'fixture',
			buildRevision: 'v1',
			manifestUrl: '/manifest.json',
			expose: './views/fixture',
			descriptor,
		},
	}
}
const entries = [
	entry('tab reports', {
		kind: 'tab',
		label: '报表',
		group: { id: 'tools', label: '业务工具' },
		order: 0,
	}),
	entry('accounts', {
		kind: 'route',
		path: '/accounts',
		title: '账户目录',
		frame: 'shell',
		order: 1,
	}),
	entry('detail', {
		kind: 'route',
		path: '/accounts/:id',
		title: '账户详情',
		frame: 'shell',
		order: 2,
	}),
	entry('signin', {
		kind: 'route',
		path: '/signin',
		title: '登录窗口',
		frame: 'standalone',
		order: 3,
	}),
	entry('reserved', { kind: 'route', path: '/logs', title: '插件日志', frame: 'shell', order: 4 }),
]
const roots: Root[] = []
beforeEach(() => {
	prepareNativeWorkbenchDom()
	source.snapshot = compileWorkbenchSnapshot(null, {
		profile: 1,
		revision: 1,
		target: null,
		entries,
	})
})
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})
async function renderNavigation(
	mode?: 'publications' | 'all',
	activePluginRoute?: string,
	activeEntryKey?: string,
) {
	const navigate = vi.fn()
	const openTab = vi.fn()
	const showNavigation = vi.fn()
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	roots.push(root)
	await act(async () =>
		root.render(
			<MantineProvider env="test">
				<WorkbenchNavigationProvider value={{ navigate, openTab }}>
					<WorkspaceNavigation
						mode={mode}
						activePluginRoute={activePluginRoute}
						activeEntryKey={activeEntryKey}
						onShowNavigation={showNavigation}
					/>
				</WorkbenchNavigationProvider>
			</MantineProvider>,
		),
	)
	return { container, navigate, openTab, showNavigation }
}
function button(label: string, exact = false) {
	const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
		exact ? element.textContent === label : element.textContent?.startsWith(label),
	)
	if (!result) throw new Error(`Navigation entry ${label} is missing`)
	return result
}
async function click(element: HTMLElement) {
	await act(async () => element.click())
}
async function input(element: HTMLInputElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
		element.dispatchEvent(new Event('input', { bubbles: true }))
	})
}

describe('workspace entry discovery', () => {
	it('navigates official and published entries in the current document without copy controls', async () => {
		const { container, navigate, openTab } = await renderNavigation()
		for (const name of ['首页', '应用', '插件管理', '日志', '认证与安全', '安全审计', '依赖图'])
			expect(button(name)).toBeDefined()
		expect(container.querySelector('[aria-label*="副本"]')).toBeNull()
		for (const [label, path] of [
			['首页', '/'],
			['报表', `${buildPluginDetailHref(owner)}?entry=tab%20reports`],
			['账户目录', '/accounts'],
			['登录窗口', '/signin'],
		]) {
			await click(button(label))
			expect(navigate).toHaveBeenLastCalledWith(path)
		}
		expect(openTab).not.toHaveBeenCalled()
	})

	it('includes status-grouped plugin results in global search and opens the current document', async () => {
		const { container, navigate, openTab } = await renderNavigation(
			'all',
			formatPluginNodeRoute(owner),
		)
		expect(button('Accounts East config').getAttribute('aria-current')).toBe('page')
		expect(button('Accounts West config').hasAttribute('aria-current')).toBe(false)
		const running = container.querySelector('[role="group"][aria-label="运行中"]')!
		expect(
			[...running.querySelectorAll('.plx-workspace-navigation__link')].map(
				(item) => item.textContent,
			),
		).toEqual(['Accounts East config运行中', 'Accounts North config运行中'])
		await click(button('Accounts East config'))
		expect(navigate).toHaveBeenLastCalledWith(buildPluginDetailHref(owner))
		await input(container.querySelector<HTMLInputElement>('[aria-label="查找工作区入口"]')!, 'West')
		expect(container.textContent).not.toContain('Accounts East config')
		expect(button('Accounts West config')).toBeDefined()
		expect(openTab).not.toHaveBeenCalled()
	})

	it('groups published pages by owner and category, honors navigation labels, and excludes unlisted routes', async () => {
		const published = entry('accounts-navigation', {
			kind: 'route',
			path: '/accounts-index',
			title: '账户目录文档',
			navigation: { label: '账户入口', group: { id: 'tools', label: '业务工具' } },
			frame: 'shell',
			order: 1,
		})
		const secondOwner: PluginNodeAddress = { ...owner, variant: 'fork', forkId: 'west' }
		const secondEntry = {
			...entry('west-tab', { kind: 'tab', label: '西区账户', order: 3 }),
			target: { node: secondOwner, displayName: 'Accounts West' },
		}
		source.snapshot = compileWorkbenchSnapshot(null, {
			profile: 1,
			revision: 2,
			target: null,
			entries: [...entries, published, secondEntry],
		})
		const { container, navigate, openTab } = await renderNavigation(
			'publications',
			formatPluginNodeRoute(owner),
			'tab reports',
		)
		const east = container.querySelector('[role="group"][aria-label="Accounts East · 业务工具"]')!
		expect(east.textContent).toContain('报表')
		expect(east.textContent).toContain('账户入口')
		const west = container.querySelector('[role="group"][aria-label="Accounts West"]')!
		expect(west.textContent).toContain('西区账户')
		expect(west.textContent).not.toContain('报表')
		expect(button('报表').getAttribute('aria-current')).toBe('page')
		expect(button('账户入口').hasAttribute('aria-current')).toBe(false)
		expect(button('西区账户').hasAttribute('aria-current')).toBe(false)
		for (const name of [
			'首页',
			'认证与安全',
			'账户详情',
			'登录窗口',
			'Accounts East config',
			'插件目录',
		])
			expect(container.textContent).not.toContain(name)
		expect(container.querySelector('[aria-label="账户目录：在新标签打开副本"]')).toBeNull()
		await click(button('账户入口'))
		expect(navigate).toHaveBeenLastCalledWith('/accounts-index')
		expect(openTab).not.toHaveBeenCalled()
		await click(button('西区账户'))
		expect(navigate).toHaveBeenLastCalledWith(
			`${buildPluginDetailHref(secondOwner)}?entry=west-tab`,
		)
		const query = container.querySelector<HTMLInputElement>('[aria-label="查找工作区入口"]')!
		await input(query, '账户入口')
		expect(button('账户入口')).toBeDefined()
		expect(container.textContent).not.toContain('西区账户')
		await act(async () =>
			query.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
		)
		expect(navigate).toHaveBeenLastCalledWith('/accounts-index')
	})

	it('temporarily expands matching groups during search and keeps the manual collapsed preference', async () => {
		const { container } = await renderNavigation('publications')
		const group = container.querySelector('[role="group"][aria-label="Accounts East · 业务工具"]')!
		const heading = group.querySelector<HTMLButtonElement>('[aria-expanded]')!
		await click(heading)
		expect(heading.getAttribute('aria-expanded')).toBe('false')
		expect(group.querySelector<HTMLElement>('.plx-workspace-navigation__rows')!.hidden).toBe(true)
		const query = container.querySelector<HTMLInputElement>('[aria-label="查找工作区入口"]')!
		await input(query, 'East')
		expect(heading.getAttribute('aria-expanded')).toBe('true')
		expect(group.querySelector<HTMLElement>('.plx-workspace-navigation__rows')!.hidden).toBe(false)
		const current = button('报表')
		expect(current.getAttribute('title')).toContain('Accounts East · 业务工具')
		expect(current.getAttribute('aria-label')).toBe('报表')
		await input(query, '')
		expect(heading.getAttribute('aria-expanded')).toBe('false')
	})

	it('requires concrete local route parameters and keeps search/hash when navigating the current document', async () => {
		const { navigate, openTab } = await renderNavigation()
		await click(button('账户详情'))
		const path = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
		const open = button('打开页面', true)
		expect(open.disabled).toBe(true)
		for (const invalid of [
			'/accounts/:id?view=grid',
			'/wrong/123',
			'//evil.example/accounts/123',
		]) {
			await input(path, invalid)
			expect(open.disabled).toBe(true)
		}
		await input(path, '/accounts/a%20b?view=grid#history')
		expect(open.disabled).toBe(false)
		await click(open)
		expect(navigate).toHaveBeenCalledExactlyOnceWith('/accounts/a%20b?view=grid#history')
		expect(openTab).not.toHaveBeenCalled()
	})

	it('lets search find publication groups and the closed navigation tool; Escape clears the query before closing a dialog', async () => {
		const { container, navigate, showNavigation } = await renderNavigation()
		const query = container.querySelector<HTMLInputElement>('[aria-label="查找工作区入口"]')!
		await input(query, '业务工具')
		expect(button('报表')).toBeDefined()
		expect(container.textContent).not.toContain('账户目录')
		const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
		await act(async () => query.dispatchEvent(escape))
		expect(escape.defaultPrevented).toBe(true)
		expect(query.value).toBe('')
		await input(query, 'navigation')
		await act(async () =>
			query.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
		)
		expect(showNavigation).toHaveBeenCalledOnce()
		expect(navigate).not.toHaveBeenCalled()
	})
})

// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PluginNodeAddress } from '@pluxel/core'
import type { WorkbenchLayoutEntry } from '@pluxel/workbench/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchNavigationProvider } from '../src/app/workbench/context'
import { WorkspaceNavigation } from '../src/app/workbench/WorkspaceNavigation'
import {
	compileWorkbenchSnapshot,
	type WorkbenchTargetSnapshot,
} from '../src/workbench/client-snapshot'
import { buildPluginDetailHref, buildWorkbenchHref } from '../src/workbench/paths'
import { prepareNativeWorkbenchDom } from './helpers/native-workbench'

const source = vi.hoisted(() => ({ snapshot: undefined as WorkbenchTargetSnapshot | undefined }))
vi.mock('../src/workbench/runtime', () => ({ useWorkbenchTargetSnapshot: () => source.snapshot }))

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
		group: { key: 'tools', label: '业务工具' },
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
async function renderNavigation() {
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
					<WorkspaceNavigation onShowNavigation={showNavigation} />
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
	it('discovers all built-ins and every publication entry, preserving fork identity, copies, and standalone navigation', async () => {
		const { container, navigate, openTab } = await renderNavigation()
		for (const name of ['首页', '插件', '日志', '认证与安全', '安全审计', '依赖图'])
			expect(button(name)).toBeDefined()
		for (const name of ['报表', '账户目录', '账户详情', '登录窗口', '插件日志'])
			expect(button(name)).toBeDefined()
		await click(container.querySelector('[aria-label="首页：在新标签打开副本"]')!)
		expect(openTab).toHaveBeenLastCalledWith({ path: '/', title: '首页' })
		await click(button('报表'))
		expect(navigate).toHaveBeenLastCalledWith(`${buildPluginDetailHref(owner)}?entry=tab%20reports`)
		await click(container.querySelector('[aria-label="报表：在新标签打开副本"]')!)
		expect(openTab).toHaveBeenLastCalledWith({
			path: `${buildPluginDetailHref(owner)}?entry=tab%20reports`,
			title: '报表',
		})
		await click(button('账户目录'))
		expect(navigate).toHaveBeenLastCalledWith('/accounts')
		await click(container.querySelector('[aria-label="账户目录：在新标签打开副本"]')!)
		expect(openTab).toHaveBeenLastCalledWith({ path: '/accounts', title: '账户目录' })
		await click(button('登录窗口'))
		expect(navigate).toHaveBeenLastCalledWith('/signin')
		expect(container.querySelector('[aria-label="登录窗口：在新标签打开副本"]')).toBeNull()
		await click(button('插件日志'))
		expect(navigate).toHaveBeenLastCalledWith(buildWorkbenchHref(owner, '/logs'))
	})

	it('requires concrete local route parameters and keeps search/hash when opening a separate document', async () => {
		const { container, navigate, openTab } = await renderNavigation()
		await click(container.querySelector('[aria-label="账户详情：在新标签打开副本"]')!)
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
		expect(openTab).toHaveBeenCalledExactlyOnceWith({
			path: '/accounts/a%20b?view=grid#history',
			title: '账户详情',
		})
		expect(navigate).not.toHaveBeenCalled()
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

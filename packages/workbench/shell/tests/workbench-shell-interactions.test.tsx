// @vitest-environment jsdom

import { ModalsProvider } from '@mantine/modals'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Actions, DockLocation, Model, TabNode } from 'flexlayout-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppThemeProvider } from '../src/app/AppThemeProvider'
import { NotificationCenterProvider } from '../src/app/notifications/NotificationCenterProvider'
import { notifyAndRecord } from '../src/app/notifications/notifyBridge'
import { WorkbenchNavigationProvider } from '../src/app/workbench/context'
import { WorkspaceSessionProvider } from '../src/app/workbench/workspaceContext'
import { WorkspaceSession } from '../src/app/workbench/session'
import { WorkbenchShell } from '../src/app/workbench/WorkbenchShell'
import { ACCENT_STORAGE_KEY } from '../src/theme/accent/accentPresets'
import { openDocument, prepareNativeWorkbenchDom } from './helpers/native-workbench'

vi.mock('../src/workbench/runtime', () => ({
	useWorkbenchTargetSnapshot: () => ({ layout: { entries: [], revision: 1 } }),
	useWorkbenchRuntime: () => ({ runningPluginsReady: false, runningPluginKeys: new Set() }),
}))

vi.mock('../src/app/product', () => ({ useProduct: () => ({ displayName: 'Fixture Workbench' }) }))
vi.mock('../src/app/workbench/shell/WorkbenchUpdateStatus', () => ({
	WorkbenchUpdateStatus: () => <span>运行更新</span>,
}))
vi.mock('../src/app/router/screens/HomeScreen', () => ({
	HomeScreen: () => <input aria-label="文档输入" defaultValue="draft" />,
}))
vi.mock('../src/app/log_viewer/LiveLog', () => ({
	LiveLog: () => <input aria-label="日志输入" defaultValue="draft" />,
}))
vi.mock('../src/app/plugins/catalog/PluginCatalog', () => ({
	PluginCatalog: () => <input aria-label="插件输入" defaultValue="draft" />,
}))
vi.mock('../src/app/security/SecurityScreen', () => ({
	SecurityScreen: () => <input aria-label="安全输入" defaultValue="draft" />,
}))
vi.mock('../src/app/workbench/WorkspaceNavigation', () => ({
	WorkspaceNavigation: ({
		autofocus = false,
		openMode,
	}: {
		autofocus?: boolean
		openMode?: string
	}) => (
		<input
			data-open-mode={openMode}
			autoFocus={autofocus}
			data-autofocus={autofocus || undefined}
			aria-label="入口搜索"
		/>
	),
}))

const roots: Root[] = []
const sessions: WorkspaceSession[] = []
beforeEach(prepareNativeWorkbenchDom)
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount()
		for (const session of sessions.splice(0)) await session.dispose()
	})
	document.body.replaceChildren()
	window.localStorage.clear()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})
async function workspace() {
	const session = new WorkspaceSession()
	sessions.push(session)
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	roots.push(root)
	await act(async () =>
		root.render(
			<AppThemeProvider>
				<ModalsProvider>
					<NotificationCenterProvider>
						<WorkspaceSessionProvider value={session}>
							<WorkbenchNavigationProvider
								value={{ navigate: () => undefined, openTab: () => undefined }}
							>
								<WorkbenchShell />
							</WorkbenchNavigationProvider>
						</WorkspaceSessionProvider>
					</NotificationCenterProvider>
				</ModalsProvider>
			</AppThemeProvider>,
		),
	)
	return { session, container }
}
function tab(container: HTMLElement, id: string) {
	const element = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((candidate) =>
		candidate.getAttribute('aria-controls')?.endsWith(id),
	)
	if (!element) throw new Error(`Native tab ${id} is missing`)
	return element
}
async function click(element: HTMLElement) {
	await act(async () => element.click())
}
async function appear(selector: string) {
	await act(async () => {
		await vi.waitUntil(() => document.querySelector(selector))
	})
}
async function pressKey(element: HTMLElement, key: string, options: KeyboardEventInit = {}) {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
	await act(async () => {
		element.dispatchEvent(event)
		element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, ...options }))
	})
	return event
}

describe('native Shell interaction contracts', () => {
	it('offers one native new-tab button on the active document and separates new from reuse search', async () => {
		const { session, container } = await workspace()
		const first = await openDocument(session, '/logs')
		const second = await openDocument(session, '/security')
		await act(async () => {
			await session.workbench.dispatch(
				Actions.moveNode(
					second,
					session.workbench.getDocument(first)!.containerId,
					DockLocation.RIGHT,
					-1,
				),
			)
			session.workbench.activate(first)
		})
		expect(container.querySelectorAll('[aria-label="新建标签页"]')).toHaveLength(1)
		expect(tab(container, first).querySelector('[aria-label="新建标签页"]')).not.toBeNull()
		expect(tab(container, second).querySelector('[aria-label="新建标签页"]')).toBeNull()
		await click(container.querySelector('[aria-label="新建标签页"]')!)
		await appear('[role="dialog"]')
		expect(document.querySelector('[aria-label="入口搜索"]')?.getAttribute('data-open-mode')).toBe(
			'new',
		)
		expect(session.workbench.getDocuments()).toHaveLength(2)
		await pressKey(document.querySelector('[aria-label="入口搜索"]')!, 'Escape', { code: 'Escape' })
		await click(container.querySelector('[aria-label="查找所有工作区入口"]')!)
		expect(document.querySelector('[aria-label="入口搜索"]')?.getAttribute('data-open-mode')).toBe(
			'reuse',
		)
	})

	it('keeps official shortcuts separate and persists icon/label mode without touching documents', async () => {
		const { session, container } = await workspace()
		const id = await openDocument(session, '/plugins')
		const input = container.querySelector<HTMLInputElement>('[aria-label="插件输入"]')!
		input.value = 'independent draft'
		const rail = container.querySelector('[aria-label="官方入口"]')!
		expect(rail.getAttribute('data-mode')).toBe('icons')
		expect(
			[...rail.querySelectorAll('.plx-activity__items button')].map((item) =>
				item.getAttribute('aria-label'),
			),
		).toEqual(['首页', '应用', '插件管理', '日志', '认证与安全', '安全审计', '依赖图'])
		await click(container.querySelector('[aria-label="显示图标与文字"]')!)
		expect(rail.getAttribute('data-mode')).toBe('labels')
		await act(async () => {
			await session.setNavigationView('panel:fixture:navigation')
			session.workbench.activate('navigation')
		})
		const restored = new WorkspaceSession({ snapshot: session.workbench.snapshot() })
		sessions.push(restored)
		expect(restored.navigationMode()).toBe('labels')
		expect(restored.navigationView()).toBe('panel:fixture:navigation')
		expect(session.workbench.getActiveDocument()?.id).toBe(id)
		await click(container.querySelector('[aria-label="左侧导航"]')!)
		await click(container.querySelector('[aria-label="左侧导航"]')!)
		expect(session.navigationView()).toBe('panel:fixture:navigation')
		expect(
			session.workbench.getLayout().borders?.find((border) => border.location === 'left')?.children,
		).toHaveLength(1)
		await click(container.querySelector('[aria-label="仅显示图标"]')!)
		expect(rail.getAttribute('data-mode')).toBe('icons')
		expect(session.navigationView()).toBe('panel:fixture:navigation')
		expect(input.value).toBe('independent draft')
		expect(session.workbench.getDocument(id)).not.toBeNull()
	})

	it('reopens the closed tool and isolates document keyboard commands from text inputs', async () => {
		const { session, container } = await workspace()
		await openDocument(session, '/plugins')
		await act(async () => {
			await session.workbench.dispatch(Actions.deleteTab('navigation'))
		})
		expect(Model.fromJson(session.workbench.getLayout()).getNodeById('navigation')).toBeUndefined()
		await click(container.querySelector('.plx-activity [aria-label="插件管理"]')!)
		expect(Model.fromJson(session.workbench.getLayout()).getNodeById('navigation')).toBeInstanceOf(
			TabNode,
		)
		const logs = await openDocument(session, '/logs')
		const input = container.querySelector<HTMLInputElement>('[aria-label="日志输入"]')!
		await act(async () => input.focus())
		const edit = await pressKey(input, 'w', { ctrlKey: true, code: 'KeyW' })
		expect(edit.defaultPrevented).toBe(false)
		expect(session.workbench.getDocument(logs)).not.toBeNull()
		const target = tab(container, logs)
		await act(async () => target.focus())
		const close = await pressKey(target, 'w', { ctrlKey: true, code: 'KeyW' })
		expect(close.defaultPrevented).toBe(true)
		expect(session.workbench.getDocument(logs)).toBeNull()
		await act(async () => {
			await vi.waitUntil(() => document.activeElement === container.querySelector('.plx-workspace'))
		})
	})

	it('keeps scoped keyboard commands available when maximizing hides a focused sibling container', async () => {
		const { session, container } = await workspace()
		const logs = await openDocument(session, '/logs')
		const security = await openDocument(session, '/security')
		const input = container.querySelector<HTMLInputElement>('[aria-label="安全输入"]')!
		input.value = 'retained across maximize'
		const group = session.workbench.getEditingContext().activeGroupId!
		await act(async () => {
			await session.workbench.dispatch(Actions.moveNode(security, group, DockLocation.RIGHT, -1))
			session.workbench.activate(logs)
		})
		const shell = container.querySelector<HTMLElement>('.plx-workspace')!
		const focusedSibling = tab(container, security)
		await act(async () => focusedSibling.focus())
		await pressKey(focusedSibling, 'M', {
			code: 'KeyM',
			ctrlKey: true,
			shiftKey: true,
		})
		expect(Model.fromJson(session.workbench.getLayout()).getMaximizedTabset()).toBeDefined()
		await act(async () => {
			await vi.waitUntil(() => document.activeElement === shell)
		})
		await pressKey(shell, 'M', { code: 'KeyM', ctrlKey: true, shiftKey: true })
		expect(Model.fromJson(session.workbench.getLayout()).getMaximizedTabset()).toBeUndefined()
		expect(container.querySelector('[aria-label="安全输入"]')).toBe(input)
		expect(input.value).toBe('retained across maximize')
	})

	it('opens entry search from an editor, cycles documents by physical bracket keys, and redraws dirty state without remounting content', async () => {
		const { session, container } = await workspace()
		const logs = await openDocument(session, '/logs')
		const input = container.querySelector<HTMLInputElement>('[aria-label="日志输入"]')!
		input.value = 'keep this draft'
		await openDocument(session, '/security')
		const shell = container.querySelector<HTMLElement>('.plx-workspace')!
		await act(async () => shell.focus())
		await pressKey(shell, '{', { code: 'BracketLeft', ctrlKey: true, shiftKey: true })
		expect(session.workbench.getActiveDocument()?.id).toBe(logs)
		expect(container.querySelector('[aria-label="日志输入"]')).toBe(input)
		await act(async () => {
			session.documents.get(logs)!.editor = { isDirty: () => true, getCloseRevision: () => 1 }
			session.notifyContentState()
		})
		expect(tab(container, logs).querySelector('[aria-label="未保存的更改"]')).not.toBeNull()
		expect(input.value).toBe('keep this draft')
		await act(async () => input.focus())
		const search = await pressKey(input, 'p', { ctrlKey: true, code: 'KeyP' })
		expect(search.defaultPrevented).toBe(true)
		await appear('[role="dialog"]')
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain('查找工作区入口')
		expect(document.activeElement?.getAttribute('aria-label')).toBe('入口搜索')
	})

	it('changes light/dark/system and accent settings through the retained Mantine Provider while native documents keep their DOM', async () => {
		const { session, container } = await workspace()
		const logs = await openDocument(session, '/logs')
		const input = container.querySelector<HTMLInputElement>('[aria-label="日志输入"]')!
		input.value = 'theme should retain me'
		await click(container.querySelector('[aria-label="主题设置"]')!)
		await appear('.mantine-Popover-dropdown')
		const scheme = document.querySelector<HTMLInputElement>('input[value="dark"]')!
		await click(scheme)
		expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('dark')
		expect(window.localStorage.getItem('pluxel-color-scheme')).toBe('dark')
		await click(document.querySelector<HTMLInputElement>('input[value="auto"]')!)
		expect(window.localStorage.getItem('pluxel-color-scheme')).toBe('auto')
		await click(document.querySelector('[aria-label="主题色：靛蓝"]')!)
		expect(JSON.parse(window.localStorage.getItem(ACCENT_STORAGE_KEY)!)).toBe('indigo')
		expect(session.workbench.getDocument(logs)).not.toBeNull()
		expect(container.querySelector('[aria-label="日志输入"]')).toBe(input)
		expect(input.value).toBe('theme should retain me')
	})

	it('keeps notification history reachable from the compact toolbar', async () => {
		const { container } = await workspace()
		await act(async () =>
			notifyAndRecord({ title: '保存结果', message: '配置已保存', color: 'green' }),
		)
		await click(container.querySelector('[aria-label="通知历史，1 条未读"]')!)
		await appear('.mantine-Popover-dropdown')
		expect(document.querySelector('.mantine-Popover-dropdown')?.textContent).toContain('配置已保存')
		expect(container.querySelector('[aria-label="通知历史，0 条未读"]')).not.toBeNull()
		const clear = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
			(element) => element.textContent === '清空历史',
		)!
		await click(clear)
		expect(document.querySelector('.mantine-Popover-dropdown')?.textContent).toContain('暂无通知')
	})
})

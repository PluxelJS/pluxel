// @vitest-environment jsdom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Workbench } from '@worksplit/react'
import { Actions, DockLocation, TabGroupNode, TabNode } from 'flexlayout-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSession } from '../src/app/workbench/session'
import { useNativeMenus } from '../src/app/workbench/nativeMenus'
import {
	openDocument,
	prepareNativeWorkbenchDom,
	renderWorkspace,
} from './helpers/native-workbench'

vi.mock('../src/app/log_viewer/LogPreview', () => ({ LogPreview: () => null }))
vi.mock('../src/app/home/HomeIntro', () => ({
	HomeIntro: () => <input aria-label="文档输入" defaultValue="draft" />,
}))
vi.mock('../src/app/log_viewer/LogsPage', () => ({
	LogsPage: () => <input aria-label="日志输入" defaultValue="draft" />,
}))
vi.mock('../src/app/security/SecurityScreen', () => ({
	SecurityScreen: () => <input aria-label="安全输入" defaultValue="draft" />,
}))
vi.mock('../src/app/workbench/WorkspaceNavigation', () => ({
	WorkspaceNavigation: () => <input aria-label="入口搜索" />,
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

function Menus({ session }: { session: WorkspaceSession }) {
	const menu = useNativeMenus(session)
	return (
		<div tabIndex={-1} data-testid="workspace">
			<Workbench instance={session.workbench} native={menu.native} menus={menu.menus} />
		</div>
	)
}
async function workspace() {
	const session = new WorkspaceSession()
	sessions.push(session)
	const view = await renderWorkspace(session, <Menus session={session} />)
	roots.push(view.root)
	return { session, ...view }
}
function tab(container: HTMLElement, id: string) {
	const result = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((element) =>
		element.getAttribute('aria-controls')?.endsWith(id),
	)
	if (!result) throw new Error(`Native tab ${id} is missing`)
	return result
}
async function context(target: HTMLElement) {
	await act(async () => {
		target.dispatchEvent(
			new MouseEvent('pointerdown', {
				bubbles: true,
				cancelable: true,
				button: 2,
				buttons: 2,
			}),
		)
		target.dispatchEvent(
			new MouseEvent('contextmenu', {
				bubbles: true,
				cancelable: true,
				clientX: 200,
				clientY: 150,
			}),
		)
	})
	expect(document.querySelector('[role="menu"]')).not.toBeNull()
}
function menuItem(label: string) {
	const result = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
		(element) => element.textContent?.trim() === label,
	)
	if (!result) throw new Error(`Menu command ${label} is missing`)
	return result
}
async function click(element: HTMLElement) {
	await act(async () => {
		element.click()
	})
}
async function pressKey(element: HTMLElement, key: string, options: KeyboardEventInit = {}) {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
	await act(async () => {
		element.dispatchEvent(event)
	})
	return event
}
function findGroup(session: WorkspaceSession) {
	const model = session.workbench.model
	let group: TabGroupNode | undefined
	model.visitNodes((node) => {
		if (node instanceof TabGroupNode) group = node
	})
	if (!group) throw new Error('Native group is missing')
	return group
}

describe('Pluxel native workspace menus', () => {
	it('duplicates a non-active user-named document through native menus with an automatic title and an isolated draft', async () => {
		const { session, container } = await workspace()
		const source = await openDocument(session, '/logs?filter=error#tail')
		const sourceInput = container.querySelector<HTMLInputElement>(
			`[data-worksplit-content="${source}"] [aria-label="日志输入"]`,
		)!
		sourceInput.value = 'source document draft'
		await act(async () => tab(container, source).focus())
		await pressKey(tab(container, source), 'F2')
		const rename = container.querySelector<HTMLInputElement>(
			'input.flexlayout__tab_button_textbox',
		)!
		rename.value = '用户诊断名称'
		await pressKey(rename, 'Enter', { code: 'Enter' })
		const other = await openDocument(session, '/security?tab=rules#roles')
		const duplicate = vi.spyOn(session.workbench, 'duplicate')
		const copies = new Set<string>()
		for (const [command, split] of [
			['在新标签打开副本', false],
			['在右侧打开副本', true],
		] as const) {
			await act(async () => session.workbench.activate(other))
			await context(tab(container, source))
			expect(session.workbench.getActiveDocument()?.id).toBe(other)
			await click(menuItem(command))
			await act(async () => {
				await vi.waitFor(() => expect(duplicate).toHaveBeenCalledTimes(copies.size + 1))
			})
			const operation = duplicate.mock.results.at(-1)
			expect(operation?.type).toBe('return')
			const result = await operation!.value
			expect(result.status).toBe('applied')
			if (result.status !== 'applied') throw new Error(JSON.stringify(result))
			await act(async () => {
				await vi.waitFor(() =>
					expect(session.workbench.getActiveDocument()).toMatchObject({
						id: result.value.document.id,
						href: '/logs?filter=error#tail',
						title: '日志',
						preview: false,
					}),
				)
			})
			const copy = session.workbench.getDocument(result.value.document.id)!
			expect(copy.id).not.toBe(source)
			expect(copy.id).not.toBe(other)
			expect(copies.has(copy.id)).toBe(false)
			copies.add(copy.id)
			const model = session.workbench.model
			const sourceNode = model.getNodeById(source) as TabNode
			const copyNode = model.getNodeById(copy.id) as TabNode
			expect(copyNode).toBeInstanceOf(TabNode)
			expect(copyNode.getName()).toBe('日志')
			expect(copyNode.getComponent()).toBe(sourceNode.getComponent())
			expect(copyNode.isPinned()).toBe(false)
			expect(copyNode.getParent()?.getId() === sourceNode.getParent()?.getId()).toBe(!split)
			const copyInput = container.querySelector<HTMLInputElement>(
				`[data-worksplit-content="${copy.id}"] [aria-label="日志输入"]`,
			)!
			expect(copyInput).not.toBeNull()
			expect(copyInput).not.toBe(sourceInput)
			expect(copyInput.value).toBe('draft')
			copyInput.value = `isolated ${command}`
			expect(sourceInput.value).toBe('source document draft')
			expect(container.querySelector(`[data-worksplit-content="${source}"] input`)).toBe(
				sourceInput,
			)
			expect(session.workbench.getDocument(source)).toMatchObject({
				href: '/logs?filter=error#tail',
				title: '用户诊断名称',
			})
			expect(sourceNode.getName()).toBe('用户诊断名称')
			expect(document.querySelector('[role="menu"]')).toBeNull()
		}
		expect(duplicate).toHaveBeenCalledTimes(2)
		expect(duplicate).toHaveBeenNthCalledWith(1, source)
		expect(duplicate).toHaveBeenNthCalledWith(2, source, {
			destination: expect.any(Function),
		})
		expect(session.workbench.getDocuments()).toHaveLength(4)
	})

	it('pins a non-active preview through dispatch, promotes it, keeps its content, and returns focus to that tab', async () => {
		const { session, container } = await workspace()
		let first = ''
		await act(async () => {
			await session.start('/security', false)
			const opened = await session.workbench.open({ to: '/logs' }, { preview: true })
			if (opened.status !== 'applied') throw new Error(JSON.stringify(opened))
			first = opened.value.document.id
		})
		expect(session.workbench.getDocument(first)?.preview).toBe(true)
		const input = container.querySelector<HTMLInputElement>('[aria-label="日志输入"]')!
		input.value = 'retained input'
		const active = await openDocument(session, '/security')
		const dispatch = vi.spyOn(session.workbench, 'dispatch')
		const target = tab(container, first)
		await context(target)
		await click(menuItem('固定标签（分组中的标签会移出分组）'))
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: Actions.SET_TAB_PINNED }))
		expect((session.workbench.model.getNodeById(first) as TabNode).isPinned()).toBe(true)
		expect(session.workbench.getDocument(first)?.preview).toBe(false)
		expect(session.workbench.getActiveDocument()?.id).toBe(active)
		expect(container.querySelector('[aria-label="日志输入"]')).toBe(input)
		expect(input.value).toBe('retained input')
		expect(document.querySelector('[role="menu"]')).toBeNull()
		expect(document.activeElement).toBe(target)
		await pressKey(target, 'F6')
		await act(async () => {
			await vi.waitFor(() => expect(document.activeElement).toBe(input))
		})
		await pressKey(input, 'F6')
		expect(document.activeElement).toBe(target)
	})

	it('allows group text editing and palette keyboard activation without triggering menu typeahead', async () => {
		const { session, container } = await workspace()
		const id = await openDocument(session, '/logs')
		await context(tab(container, id))
		const grouping = vi.spyOn(session.workbench, 'dispatch')
		await click(menuItem('加入新分组'))
		await act(async () => {
			expect(await grouping.mock.results.at(-1)!.value).toMatchObject({ status: 'applied' })
		})
		await context(container.querySelector<HTMLElement>('.flexlayout__group_pill')!)
		const name = container.querySelector<HTMLInputElement>('input[aria-label="分组名称"]')!
		expect(document.activeElement).toBe(name)
		name.value = 'Diagnostics group'
		const space = await pressKey(name, ' ')
		const left = await pressKey(name, 'ArrowLeft')
		expect(space.defaultPrevented).toBe(false)
		expect(left.defaultPrevented).toBe(false)
		expect(document.activeElement).toBe(name)
		await pressKey(name, 'Enter')
		expect(findGroup(session).getName()).toBe('Diagnostics group')
		await context(container.querySelector<HTMLElement>('.flexlayout__group_pill')!)
		const colors = [
			...container.querySelectorAll<HTMLButtonElement>('.flexlayout__group_color_picker_swatch'),
		]
		await act(async () => {
			colors[0]!.focus()
		})
		await pressKey(colors[0]!, 'ArrowRight')
		expect(document.activeElement).toBe(colors[1])
		const activateColor = await pressKey(colors[1]!, 'Enter')
		expect(activateColor.defaultPrevented).toBe(false)
		// JSDOM has no native button keyboard default; the raw browser fixture presses Enter/Space.
		await click(colors[1]!)
		expect(findGroup(session).getColor()).toBe('#dd8a4a')
		expect(document.querySelector('[role="menu"]')).not.toBeNull()
		await pressKey(colors[1]!, 'Escape')
		expect(document.querySelector('[role="menu"]')).toBeNull()
	})

	it('opens a focused tab menu by keyboard and honors the real dirty close decision', async () => {
		const { session, container } = await workspace()
		const id = await openDocument(session, '/logs')
		const state = session.documents.get(id)!
		await act(async () => {
			state.editor = {
				getState: () => ({ hasUnsavedChanges: true, token: 1 }),
				isWritePending: () => false,
			}
			session.notifyContentState()
		})
		const target = tab(container, id)
		await act(async () => target.focus())
		await pressKey(target, 'F10', { shiftKey: true })
		expect(document.querySelector('[role="menu"]')).not.toBeNull()
		await click(menuItem('关闭标签'))
		const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
			(button) => button.textContent === '保留文档',
		)!
		expect(cancel).toBeDefined()
		await click(cancel)
		expect(session.workbench.getDocument(id)).not.toBeNull()
		expect(container.querySelector('[aria-label="日志输入"]')).not.toBeNull()
	})

	it('uses native split, container focus, content focus, rename, and pinned close protection without replacing document DOM', async () => {
		const { session, container } = await workspace()
		const logs = await openDocument(session, '/logs')
		const security = await openDocument(session, '/security')
		const input = container.querySelector<HTMLInputElement>('[aria-label="安全输入"]')!
		input.value = 'retained security draft'
		await context(tab(container, security))
		await click(menuItem('将标签拆分到右侧'))
		expect(container.querySelector('[aria-label="安全输入"]')).toBe(input)
		expect(input.value).toBe('retained security draft')
		await act(async () => tab(container, logs).focus())
		await pressKey(tab(container, logs), 'F6', { ctrlKey: true })
		expect(document.activeElement).toBe(tab(container, security))
		await pressKey(tab(container, security), 'F6')
		expect(document.activeElement).toBe(input)
		await pressKey(input, 'F6')
		expect(document.activeElement).toBe(tab(container, security))
		await pressKey(tab(container, security), 'F2')
		const rename = container.querySelector<HTMLInputElement>(
			'input.flexlayout__tab_button_textbox',
		)!
		expect(rename).not.toBeNull()
		rename.value = 'Security draft'
		await pressKey(rename, 'Enter', { code: 'Enter' })
		expect(session.workbench.getDocument(security)?.title).toBe('Security draft')
		expect(container.querySelector('[aria-label="安全输入"]')).toBe(input)
		await context(tab(container, security))
		await click(menuItem('固定标签（分组中的标签会移出分组）'))
		const close = await pressKey(tab(container, security), 'Delete', { ctrlKey: true })
		expect(close.defaultPrevented).toBe(false)
		expect(session.workbench.getDocument(security)).not.toBeNull()
		await context(tab(container, security))
		expect(menuItem('关闭标签').getAttribute('aria-disabled')).toBe('true')
	})

	it('closes a deleted group menu and focuses the surviving workspace, including after its old DOM is clicked', async () => {
		const { session, container } = await workspace()
		const id = await openDocument(session, '/logs')
		await act(async () => {
			await session.workbench.dispatch(Actions.addTabToNewGroup(id, 'Temporary'))
		})
		const group = findGroup(session)
		await context(container.querySelector<HTMLElement>('.flexlayout__group_pill')!)
		const stale = menuItem('关闭整个标签容器（含折叠分组）')
		await act(async () => {
			await session.workbench.dispatch(Actions.ungroup(group.getId()))
		})
		expect(document.querySelector('[role="menu"]')).toBeNull()
		const nativeScope = container.querySelector<HTMLElement>('.worksplit-workbench')!
		await act(async () => {
			await vi.waitFor(() => expect(document.activeElement).toBe(nativeScope))
		})
		await click(stale)
		expect(session.workbench.getDocument(id)).not.toBeNull()
		expect(document.activeElement).toBe(nativeScope)
	})

	it('closes the current whole group, including a member added after the menu opened', async () => {
		const { session, container } = await workspace()
		const logs = await openDocument(session, '/logs')
		const security = await openDocument(session, '/security')
		await act(async () => {
			await session.workbench.dispatch(Actions.addTabToNewGroup(logs, 'Diagnostics'))
		})
		const group = findGroup(session)
		await context(container.querySelector<HTMLElement>('.flexlayout__group_pill')!)
		await act(async () => {
			await session.workbench.dispatch(
				Actions.moveNode(security, group.getId(), DockLocation.CENTER, -1),
			)
		})
		await click(menuItem('关闭整个标签容器（含折叠分组）'))
		expect(session.workbench.getDocuments()).toHaveLength(0)
		expect(container.querySelector('[aria-label="日志输入"]')).toBeNull()
		expect(container.querySelector('[aria-label="安全输入"]')).toBeNull()
	})

	it('closes a menu when its native tab moves to another container and ignores retained callbacks', async () => {
		const { session, container } = await workspace()
		const logs = await openDocument(session, '/logs')
		await openDocument(session, '/security')
		const input = container.querySelector('[aria-label="日志输入"]')!
		await context(tab(container, logs))
		const stale = menuItem('关闭标签')
		const target = (session.workbench.model.getNodeById(logs) as TabNode).getParent()!.getId()
		await act(async () => {
			await session.workbench.dispatch(Actions.moveNode(logs, target, DockLocation.RIGHT, -1))
		})
		expect(document.querySelector('[role="menu"]')).toBeNull()
		await act(async () => {
			await vi.waitFor(() =>
				expect(document.activeElement).toBe(container.querySelector('.worksplit-workbench')),
			)
		})
		await click(stale)
		expect(session.workbench.getDocument(logs)).not.toBeNull()
		expect(container.querySelector('[aria-label="日志输入"]')).toBe(input)
	})

	it('keeps native custom Border controls under the Mantine Provider and removes portals on unmount', async () => {
		const { session, container, root } = await workspace()
		await act(async () => {
			await session.start('/', false)
			await session.workbench.dispatch(Actions.updateNodeAttributes('border_left', { show: true }))
		})
		const trigger = container.querySelector<HTMLElement>('.flexlayout__border')!
		await context(trigger)
		const size = container.querySelector<HTMLInputElement>('.mantine-NumberInput-input')!
		expect(size).not.toBeNull()
		expect(size.value).toBe('280')
		const left = await pressKey(size, 'ArrowLeft')
		expect(left.defaultPrevented).toBe(false)
		await click(menuItem('边栏悬浮显示'))
		expect(session.workbench.model.toJson().borders?.[0]?.borderType).toBe('overlay')
		await context(trigger)
		expect(container.querySelector('[role="menu"]')).not.toBeNull()
		await act(async () => root.unmount())
		roots.splice(roots.indexOf(root), 1)
		expect(document.querySelector('.flexlayout__popup_menu_container')).toBeNull()
	})

	it('uses the native overflow candidates and selection callback with keyboard focus return', async () => {
		const { session, container } = await workspace()
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
			this: HTMLElement,
		) {
			if (this.matches('[role="tab"]')) return new DOMRect(800, 0, 120, 30)
			if (this.classList.contains('flexlayout__tabset_tabbar_inner'))
				return new DOMRect(0, 0, 260, 34)
			return new DOMRect(0, 0, 1200, 800)
		})
		const logs = await openDocument(session, '/logs')
		await openDocument(session, '/security')
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 110))
		})
		const overflow = container.querySelector<HTMLButtonElement>('.flexlayout__tab_button_overflow')!
		expect(overflow).not.toBeNull()
		await click(overflow)
		expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('查看溢出标签')
		const items = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')]
		expect(items.map((item) => item.textContent)).toContain(
			session.workbench.getDocument(logs)?.title,
		)
		expect(
			items.some((item) => item.classList.contains('flexlayout__popup_menu_item--selected')),
		).toBe(true)
		await pressKey(items[0]!, 'End')
		expect(document.activeElement).toBe(items.at(-1))
		await pressKey(document.activeElement as HTMLElement, 'Home')
		await pressKey(document.activeElement as HTMLElement, 'Enter')
		expect(session.workbench.getActiveDocument()?.id).toBe(logs)
		expect(document.querySelector('[role="menu"]')).toBeNull()
		expect(document.activeElement).toBe(overflow)
	})
})

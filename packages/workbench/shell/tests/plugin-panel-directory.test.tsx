// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core'
import type { PluginNodeAddress } from '@pluxel/core'
import type { WorkbenchLayoutEntry } from '@pluxel/workbench/client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginPanelDirectory } from '../src/app/workbench/PluginPanelDirectory'
import { WorkspaceNavigation } from '../src/app/workbench/WorkspaceNavigation'
import { WorkbenchNavigationProvider } from '../src/app/workbench/context'
import { compileWorkbenchSnapshot } from '../src/workbench/client-snapshot'
import { prepareNativeWorkbenchDom } from './helpers/native-workbench'

const fixture = vi.hoisted(() => ({
	session: null as any,
	target: null as any,
	global: null as any,
	running: true,
}))
vi.mock('../src/app/workbench/workspaceContext', () => ({
	useOptionalWorkspaceSession: () => fixture.session,
}))
vi.mock('@worksplit/react', async (importOriginal) => ({
	...(await importOriginal<typeof import('@worksplit/react')>()),
	useWorkbenchState: (_workbench: unknown, select: (state: unknown) => unknown) =>
		select({ activeDocumentId: 'doc', revision: 1 }),
}))
vi.mock('../src/workbench/runtime', () => ({
	useWorkbenchTargetSnapshot: (owner: unknown) => (owner ? fixture.target : fixture.global),
	useWorkbenchRuntime: () => ({
		runningPluginsReady: !fixture.running,
		runningPluginKeys: new Set(),
	}),
}))
vi.mock('../src/app/plugins/pluginOverview', () => ({
	usePluginOverview: () => ({ overview: { status: { statuses: [] } } }),
}))
const owner: PluginNodeAddress = {
	definition: { entry: { kind: 'package-root', packageName: '@test/bots' }, exportName: 'Bots' },
	variant: 'fork',
	forkId: 'east',
}
function panel(key: string, label: string, node = owner): WorkbenchLayoutEntry {
	const descriptor = { kind: 'content' as const, owner: owner.definition, key }
	return {
		descriptor,
		target: { node, displayName: 'Bot workspace' },
		definitionRevisions: { target: 1 },
		placement: { kind: 'panel', region: 'left', label, order: 0 },
		contentRef: { profile: 1, digest: 'test', descriptor },
	}
}
const bots = panel('bots', '机器人列表')
const roots: Root[] = []
beforeEach(() => {
	prepareNativeWorkbenchDom()
	fixture.running = true
	fixture.session = {
		workbench: {},
		documents: new Map([['doc', { plugin: owner }]]),
		subscribeContentState: () => () => {},
		getContentRevision: () => 0,
		isPanelOpen: vi.fn(() => false),
		openPanel: vi.fn(async () => {}),
		report: vi.fn(),
	}
	fixture.target = compileWorkbenchSnapshot(owner, {
		profile: 1,
		revision: 1,
		target: { node: owner, displayName: 'Bot workspace' },
		entries: [bots, panel('other', '其他实例', { ...owner, forkId: 'west' })],
	})
	fixture.global = compileWorkbenchSnapshot(null, {
		profile: 1,
		revision: 1,
		target: null,
		entries: [],
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
async function render(content: React.ReactNode) {
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	roots.push(root)
	await act(async () =>
		root.render(
			<MantineProvider env="test">
				<WorkbenchNavigationProvider value={{ navigate: vi.fn(), openTab: vi.fn() }}>
					{content}
				</WorkbenchNavigationProvider>
			</MantineProvider>,
		),
	)
	return container
}

describe('current plugin extension discovery', () => {
	it('lists only exact owner declarations without opening them and routes explicit opens to the session', async () => {
		const container = await render(<PluginPanelDirectory />)
		expect(container.textContent).toContain('机器人列表')
		expect(container.textContent).not.toContain('其他实例')
		expect(fixture.session.openPanel).not.toHaveBeenCalled()
		await act(async () =>
			container.querySelector<HTMLButtonElement>('[aria-label="打开 机器人列表"]')!.click(),
		)
		expect(fixture.session.openPanel).toHaveBeenCalledExactlyOnceWith(bots)
	})
	it('shows opened and unavailable state, without inventing declarations for stopped owners', async () => {
		fixture.session.isPanelOpen.mockReturnValue(true)
		fixture.running = false
		const container = await render(<PluginPanelDirectory />)
		expect(container.textContent).toContain('已打开')
		expect(container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
		expect(container.textContent).toContain('插件未运行')
	})
	it('does not show a directory without an active plugin owner', async () => {
		fixture.session.documents.clear()
		const container = await render(<PluginPanelDirectory />)
		expect(container.querySelector('[aria-label="插件扩展"]')).toBeNull()
	})
	it('finds current plugin panels in the official search and opens on Enter without document navigation', async () => {
		const chosen = vi.fn()
		const container = await render(<WorkspaceNavigation onChosen={chosen} />)
		const input = container.querySelector<HTMLInputElement>('input[aria-label="查找工作区入口"]')!
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
				input,
				'机器人',
			)
			input.dispatchEvent(new Event('input', { bubbles: true }))
		})
		expect(container.textContent).toContain('机器人列表')
		expect(container.textContent).not.toContain('没有匹配的入口')
		await act(async () =>
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
		)
		expect(fixture.session.openPanel).toHaveBeenCalledExactlyOnceWith(bots)
		expect(chosen).toHaveBeenCalledOnce()
	})
	it('keeps the standalone search usable without a WorkspaceSession provider', async () => {
		fixture.session = null
		const container = await render(<WorkspaceNavigation />)
		expect(container.textContent).toContain('首页')
		expect(container.textContent).not.toContain('当前插件扩展')
	})
})

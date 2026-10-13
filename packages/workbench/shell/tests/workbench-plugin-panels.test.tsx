// @vitest-environment jsdom

import { act, useEffect } from 'react'
import type { Root } from 'react-dom/client'
import { formatPluginNodeRoute, pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import type { WorkbenchLayoutEntry } from '@pluxel/workbench/client'
import { Model, TabNode } from 'flexlayout-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginNavigation } from '../src/app/workbench/PluginNavigation'
import { PluginRegionTabs } from '../src/app/workbench/PluginPanels'
import { WorkbenchDocumentState } from '../src/app/workbench/document'
import { WorkspaceSession } from '../src/app/workbench/session'
import {
	compileWorkbenchSnapshot,
	type WorkbenchTargetSnapshot,
} from '../src/workbench/client-snapshot'
import {
	openDocument,
	prepareNativeWorkbenchDom,
	renderWorkspace,
} from './helpers/native-workbench'

vi.mock('../src/app/workbench/WorkspaceNavigation', () => ({
	WorkspaceNavigation: ({ mode }: { mode: string }) => (
		<div data-navigation-mode={mode}>Catalog</div>
	),
}))

const source = vi.hoisted(() => ({
	snapshot: undefined as WorkbenchTargetSnapshot | undefined,
	runningPluginsReady: true,
	runningPluginKeys: new Set<string>(),
	mount: vi.fn(),
	unmount: vi.fn(),
	requestedOwner: vi.fn(),
}))
vi.mock('../src/workbench/runtime', () => ({
	useWorkbenchRuntime: () => source,
	useWorkbenchTargetSnapshot: (owner: PluginNodeAddress | null) => {
		source.requestedOwner(owner)
		return source.snapshot
	},
	WorkbenchEntryView: ({
		entry,
		frame,
		layoutRevision,
		params,
	}: {
		entry: WorkbenchLayoutEntry
		frame: string
		layoutRevision: number
		params: Record<string, string>
	}) => {
		const key = `${formatPluginNodeRoute(entry.target.node)}:${entry.descriptor.key}`
		useEffect(() => {
			source.mount(key, { frame, layoutRevision, params })
			return () => {
				source.unmount(key)
			}
		}, [key, frame, layoutRevision, params])
		return <div data-panel-key={key}>Panel {entry.descriptor.key}</div>
	},
}))

type Region = 'left' | 'right' | 'bottom'
const east: PluginNodeAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@test/panel-owner' },
		exportName: 'PanelOwner',
	},
	variant: 'fork',
	forkId: 'east',
}
const west: PluginNodeAddress = { ...east, forkId: 'west' }
const other: PluginNodeAddress = {
	definition: { ...east.definition, exportName: 'OtherOwner' },
	variant: 'default',
}
const regions = ['left', 'right', 'bottom'] as const
const toolIds = { left: 'navigation', right: 'plugin-inspector', bottom: 'plugin-logs' }
function panel(
	key: string,
	region: Region,
	owner = east,
	label = `${region} ${key}`,
	order = 0,
): WorkbenchLayoutEntry {
	const descriptor = { kind: 'view' as const, owner: owner.definition, key: `${region}_${key}` }
	return {
		descriptor,
		target: { node: owner, displayName: owner.definition.exportName },
		renderer: owner,
		definitionRevisions: { target: 1, renderer: 1 },
		placement: { kind: 'panel', region, label, order },
		federatedViewRef: {
			profile: 1,
			producer: 'panel_fixture',
			buildRevision: 'build1',
			manifestUrl: '/manifest.json',
			expose: `./views/${descriptor.key}`,
			descriptor,
		},
	}
}
const builtin = { value: 'plugins', label: '内置视图', content: <div data-builtin>Built in</div> }
const roots: Root[] = []
const sessions: WorkspaceSession[] = []

beforeEach(() => {
	prepareNativeWorkbenchDom()
	window.localStorage.clear()
	source.mount.mockReset()
	source.unmount.mockReset()
	source.requestedOwner.mockReset()
	source.runningPluginsReady = true
	source.runningPluginKeys = new Set([east, west, other].map(pluginNodeIndexKey))
	source.snapshot = compileWorkbenchSnapshot(null, {
		profile: 1,
		revision: 7,
		target: null,
		entries: [
			...regions.flatMap((region) => [
				panel('one', region, east, `${region} first`, 0),
				panel('two', region, east, `${region} second`, 10),
				panel('one', region, west, `${region} west`),
				panel('one', region, other, `${region} other`),
			]),
			{ ...panel('page', 'left'), placement: { kind: 'tab', label: 'Document page', order: 0 } },
		],
	})
})
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

async function setOwner(session: WorkspaceSession, id: string, owner?: PluginNodeAddress) {
	await act(async () => {
		const state = new WorkbenchDocumentState()
		state.plugin = owner
		state.workspace = owner ? 'plugins' : undefined
		session.documents.set(id, state)
		session.workbench.activate(id)
		session.notifyContentState()
		await session.syncWorkspacePanels()
	})
}
async function renderRegion(session: WorkspaceSession, region: Region) {
	const rendered = await renderWorkspace(
		session,
		<PluginRegionTabs region={region} builtins={[builtin]} keepBuiltinMounted />,
	)
	roots.push(rendered.root)
	return rendered.container
}
async function fixture(region: Region) {
	const session = new WorkspaceSession()
	sessions.push(session)
	const id = await openDocument(session, '/plugins')
	await setOwner(session, id, east)
	await act(async () => {
		if (region === 'right') await session.toggleBorder('right')
		if (region === 'bottom') await session.toggleLogs()
	})
	return { session, id, container: await renderRegion(session, region) }
}
function tab(container: HTMLElement, label: string) {
	const result = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
		(node) => node.textContent === label,
	)
	if (!result) throw new Error(`Missing panel tab: ${label}`)
	return result
}
async function choose(container: HTMLElement, label: string) {
	await act(async () => tab(container, label).click())
}
function renderedKeys(container: HTMLElement) {
	return [...container.querySelectorAll('[data-panel-key]')].map((node) =>
		node.getAttribute('data-panel-key'),
	)
}
function selectedPanel(session: WorkspaceSession, region: Region) {
	if (region === 'left') return session.navigationView()
	const node = Model.fromJson(session.workbench.getLayout()).getNodeById(toolIds[region])
	return node instanceof TabNode ? node.getConfig()?.panelView : undefined
}

describe('owner-scoped plugin region panels', () => {
	it('uses only owner extensions in application navigation and preserves manual expansion across contexts', async () => {
		const { session, id } = await fixture('left')
		await act(async () => {
			session.documents.get(id)!.workspace = undefined
			session.notifyContentState()
			await session.syncWorkspacePanels(true)
		})
		expect(session.activeWorkspace()).toBe('apps')
		const rendered = await renderWorkspace(session, <PluginNavigation />)
		roots.push(rendered.root)
		expect(rendered.container.querySelector('[data-navigation-mode]')).toBeNull()
		expect(renderedKeys(rendered.container)).toEqual([`${formatPluginNodeRoute(east)}:left_one`])
		await act(async () => session.toggleBorder('left'))
		await act(async () => session.syncWorkspacePanels(false))
		await act(async () => session.syncWorkspacePanels(true))
		expect(session.isToolVisible('navigation')).toBe(false)
		await act(async () => session.toggleBorder('left'))
		expect(session.isToolVisible('navigation')).toBe(true)
		await act(async () => {
			source.snapshot = compileWorkbenchSnapshot(null, {
				profile: 1,
				revision: 8,
				target: null,
				entries: [],
			})
			session.notifyContentState()
			await session.syncWorkspacePanels(false)
		})
		expect(session.isToolVisible('navigation')).toBe(false)
		expect(renderedKeys(rendered.container)).toEqual([])
		await act(async () => {
			session.documents.get(id)!.workspace = 'plugins'
			session.notifyContentState()
			await session.syncWorkspacePanels(false)
		})
		expect(session.isToolVisible('navigation')).toBe(true)
		expect(
			rendered.container
				.querySelector('[data-navigation-mode]')
				?.getAttribute('data-navigation-mode'),
		).toBe('plugins')
		expect(rendered.container.textContent).not.toContain('插件页面')
	})

	it.each(regions)(
		'filters %s panels by exact fork and region and mounts only the selected extension',
		async (region) => {
			const { session, container } = await fixture(region)
			expect(
				[...container.querySelectorAll('[role="tab"]')].map((node) => node.textContent),
			).toEqual(['内置视图', `${region} first`, `${region} second`])
			expect(source.requestedOwner).toHaveBeenLastCalledWith(east)
			expect(source.mount).not.toHaveBeenCalled()
			const documents = session.workbench.getDocuments()
			const href = session.workbench.getActiveDocument()?.href
			const url = window.location.href
			const open = vi.spyOn(session.workbench, 'open')
			await choose(container, `${region} first`)
			expect(renderedKeys(container)).toEqual([`${formatPluginNodeRoute(east)}:${region}_one`])
			expect(source.mount).toHaveBeenLastCalledWith(
				`${formatPluginNodeRoute(east)}:${region}_one`,
				{
					frame: 'shell',
					layoutRevision: 7,
					params: {},
				},
			)
			await choose(container, `${region} second`)
			expect(renderedKeys(container)).toEqual([`${formatPluginNodeRoute(east)}:${region}_two`])
			expect(source.unmount).toHaveBeenCalledWith(`${formatPluginNodeRoute(east)}:${region}_one`)
			await choose(container, '内置视图')
			expect(renderedKeys(container)).toEqual([])
			expect(source.unmount).toHaveBeenCalledWith(`${formatPluginNodeRoute(east)}:${region}_two`)
			expect(open).not.toHaveBeenCalled()
			expect(session.workbench.getDocuments()).toEqual(documents)
			expect(session.workbench.getActiveDocument()?.href).toBe(href)
			expect(window.location.href).toBe(url)
		},
	)

	it.each(regions)(
		'persists the selected %s panel in the native layout and reopens it after hiding',
		async (region) => {
			const { session, container } = await fixture(region)
			await choose(container, `${region} second`)
			const selected = `panel:${formatPluginNodeRoute(east)}:${region}_two`
			expect(selectedPanel(session, region)).toBe(selected)
			await act(async () => {
				if (region === 'bottom') await session.toggleLogs()
				else await session.toggleBorder(region)
			})
			expect(renderedKeys(container)).toEqual([])
			expect(source.unmount).toHaveBeenCalledWith(`${formatPluginNodeRoute(east)}:${region}_two`)
			expect(selectedPanel(session, region)).toBe(selected)
			await act(async () => {
				if (region === 'bottom') await session.toggleLogs()
				else await session.toggleBorder(region)
			})
			expect(renderedKeys(container)).toEqual([`${formatPluginNodeRoute(east)}:${region}_two`])
			const restored = new WorkspaceSession({ snapshot: session.workbench.snapshot() })
			sessions.push(restored)
			expect(selectedPanel(restored, region)).toBe(selected)
			const id = await openDocument(restored, '/plugins')
			await setOwner(restored, id, east)
			const restoredContainer = await renderRegion(restored, region)
			expect(renderedKeys(restoredContainer)).toEqual([
				`${formatPluginNodeRoute(east)}:${region}_two`,
			])
		},
	)

	it('unmounts the old fork and uses builtin fallback until a new owner panel is selected', async () => {
		const { session, id, container } = await fixture('right')
		await choose(container, 'right first')
		const otherId = await openDocument(session, '/plugins', true)
		await setOwner(session, otherId, west)
		expect(renderedKeys(container)).toEqual([])
		expect(source.unmount).toHaveBeenCalledWith(`${formatPluginNodeRoute(east)}:right_one`)
		expect([...container.querySelectorAll('[role="tab"]')].map((node) => node.textContent)).toEqual(
			['内置视图', 'right west'],
		)
		await choose(container, 'right west')
		expect(renderedKeys(container)).toEqual([`${formatPluginNodeRoute(west)}:right_one`])
		await setOwner(session, id)
		expect(renderedKeys(container)).toEqual([])
		expect(source.unmount).toHaveBeenCalledWith(`${formatPluginNodeRoute(west)}:right_one`)
		expect(source.requestedOwner).toHaveBeenLastCalledWith(null)
	})

	it('does not open a stopped owner and releases a mounted panel when that owner stops', async () => {
		const { session, container } = await fixture('right')
		source.runningPluginKeys.delete(pluginNodeIndexKey(east))
		await choose(container, 'right first')
		expect(source.mount).not.toHaveBeenCalled()
		expect(container.textContent).toContain('插件未运行')
		await act(async () => {
			source.runningPluginKeys.add(pluginNodeIndexKey(east))
			session.notifyContentState()
		})
		expect(renderedKeys(container)).toEqual([`${formatPluginNodeRoute(east)}:right_one`])
		await act(async () => {
			source.runningPluginKeys.delete(pluginNodeIndexKey(east))
			session.notifyContentState()
		})
		expect(renderedKeys(container)).toEqual([])
		expect(source.unmount).toHaveBeenCalledWith(`${formatPluginNodeRoute(east)}:right_one`)
	})
})

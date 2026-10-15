// @vitest-environment jsdom

import { act, useEffect } from 'react'
import type { Root } from 'react-dom/client'
import { formatPluginNodeRoute, pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import type { WorkbenchLayoutEntry } from '@pluxel/workbench/client'
import { Actions, BorderNode, DockLocation, Model } from 'flexlayout-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { panelTab, panelTabId, panelIdentity } from '../src/app/workbench/panelTabs'
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

vi.mock('../src/app/workbench/PluginTools', () => ({
	PluginTool: () => <div>Official inspector</div>,
}))
vi.mock('../src/app/log_viewer/LogsPage', () => ({ LogsPage: () => <div>Document</div> }))

vi.mock('@mantine/modals', async (importOriginal) => ({
	...(await importOriginal<typeof import('@mantine/modals')>()),
	openConfirmModal: ({ onConfirm }: { onConfirm: () => void }) => onConfirm(),
}))

const source = vi.hoisted(() => ({
	snapshot: undefined as WorkbenchTargetSnapshot | undefined,
	runningPluginsReady: true,
	runningPluginKeys: new Set<string>(),
	unmount: vi.fn(),
}))
vi.mock('../src/workbench/runtime', () => ({
	useWorkbenchRuntime: () => source,
	useWorkbenchTargetSnapshot: () => source.snapshot,
	WorkbenchEntryView: ({ entry }: { entry: WorkbenchLayoutEntry }) => {
		const key = `${formatPluginNodeRoute(entry.target.node)}:${entry.descriptor.key}`
		useEffect(() => {
			return () => {
				source.unmount(key)
			}
		}, [key])
		return <div data-panel-key={key}>Panel {entry.descriptor.key}</div>
	},
}))

vi.mock('../src/app/plugins/catalog/PluginCatalog', () => ({
	PluginCatalog: () => <div>插件目录</div>,
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
const roots: Root[] = []
const sessions: WorkspaceSession[] = []

beforeEach(() => {
	prepareNativeWorkbenchDom()
	window.localStorage.clear()
	source.unmount.mockReset()
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
		const state = session.documents.get(id) ?? new WorkbenchDocumentState()
		state.plugin = owner
		state.workspace = owner ? 'plugins' : undefined
		session.documents.set(id, state)
		session.workbench.activate(id)
		session.notifyContentState()
		await session.syncWorkspacePanels(source.snapshot?.layout?.entries ?? [])
	})
}
function panelId(entry: WorkbenchLayoutEntry) {
	const identity = panelIdentity(entry)
	return panelTabId(identity.owner, identity.key)
}
function border(session: WorkspaceSession, region: Region) {
	return Model.fromJson(session.workbench.getLayout()).getNodeById(`border_${region}`) as BorderNode
}
function renderedKeys(container: HTMLElement) {
	return [...container.querySelectorAll('[data-panel-key]')].map((node) =>
		node.getAttribute('data-panel-key'),
	)
}
async function fixture() {
	const session = new WorkspaceSession()
	sessions.push(session)
	const id = await openDocument(session, '/logs')
	const rendered = await renderWorkspace(session)
	roots.push(rendered.root)
	await setOwner(session, id, east)
	return { session, id, container: rendered.container }
}
async function open(session: WorkspaceSession, entry: WorkbenchLayoutEntry) {
	await act(async () => session.openPanel(entry))
}
async function close(session: WorkspaceSession, entry: WorkbenchLayoutEntry) {
	await act(async () => {
		const closed = await session.workbench.close(panelId(entry))
		expect(closed.status).toBe('closed')
		await session.syncWorkspacePanels()
	})
}

describe('independent native plugin panel tabs', () => {
	it.each(regions)(
		'opens %s extensions explicitly, deduplicates and closes without navigating',
		async (region) => {
			const { session, container } = await fixture()
			const one = panel('one', region),
				two = panel('two', region)
			expect(session.isPanelOpen(one)).toBe(false)
			expect(renderedKeys(container)).toEqual([])
			const documents = session.workbench.getDocuments()
			const href = session.workbench.getActiveDocument()?.href
			const url = window.location.href
			await open(session, one)
			await open(session, one)
			expect(
				border(session, region)
					.getChildren()
					.filter((node) => node.getId() === panelId(one)),
			).toHaveLength(1)
			expect(renderedKeys(container)).toEqual([`${formatPluginNodeRoute(east)}:${region}_one`])
			await open(session, two)
			expect(renderedKeys(container)).toEqual([`${formatPluginNodeRoute(east)}:${region}_two`])
			expect(source.unmount).toHaveBeenCalledWith(`${formatPluginNodeRoute(east)}:${region}_one`)
			await close(session, two)
			expect(session.isPanelOpen(two)).toBe(false)
			await open(session, two)
			expect(session.isPanelOpen(two)).toBe(true)
			expect(session.workbench.getDocuments()).toEqual(documents)
			expect(session.workbench.getActiveDocument()?.href).toBe(href)
			expect(window.location.href).toBe(url)
		},
	)
	it.each(regions)(
		'releases collapsed %s content while retaining the native strip and open tab',
		async (region) => {
			const { session, container } = await fixture()
			const entry = panel('one', region)
			await open(session, entry)
			await act(async () => session.toggleBorder(region))
			expect(renderedKeys(container)).toEqual([])
			expect(source.unmount).toHaveBeenCalledWith(`${formatPluginNodeRoute(east)}:${region}_one`)
			expect(session.isPanelOpen(entry)).toBe(true)
			expect(border(session, region).isShowing()).toBe(true)
			expect(border(session, region).getSelected()).toBe(-1)
			await open(session, entry)
			expect(renderedKeys(container)).toEqual([`${formatPluginNodeRoute(east)}:${region}_one`])
		},
	)
	it('toggles the requested native tool rather than whichever border tab is selected', async () => {
		const { session, container } = await fixture()
		const entry = panel('one', 'right')
		await open(session, entry)
		await act(async () => session.toggleTool('plugin-inspector'))
		expect(border(session, 'right').getSelectedNode()?.getId()).toBe('plugin-inspector')
		expect(renderedKeys(container)).toEqual([])
		await act(async () => session.toggleTool(panelId(entry)))
		expect(border(session, 'right').getSelectedNode()?.getId()).toBe(panelId(entry))
		expect(renderedKeys(container)).toEqual([`${formatPluginNodeRoute(east)}:right_one`])
		await act(async () => session.toggleTool(panelId(entry)))
		expect(border(session, 'right').getSelected()).toBe(-1)
		expect(renderedKeys(container)).toEqual([])
		await act(async () => session.toggleTool(panelId(entry)))
		expect(border(session, 'right').getSelectedNode()?.getId()).toBe(panelId(entry))
		expect(renderedKeys(container)).toEqual([`${formatPluginNodeRoute(east)}:right_one`])
	})
	it('archives native open tabs per exact owner and restores selection without reopening closed tabs', async () => {
		const { session, id, container } = await fixture()
		const first = panel('one', 'bottom'),
			closed = panel('two', 'bottom'),
			westPanel = panel('one', 'bottom', west)
		await open(session, first)
		await open(session, closed)
		await close(session, closed)
		await open(session, first)
		await setOwner(session, id, west)
		expect(renderedKeys(container)).toEqual([])
		expect(source.unmount).toHaveBeenCalledWith(`${formatPluginNodeRoute(east)}:bottom_one`)
		expect(session.isPanelOpen(first)).toBe(false)
		await open(session, westPanel)
		await setOwner(session, id, east)
		expect(session.isPanelOpen(first)).toBe(true)
		expect(session.isPanelOpen(closed)).toBe(false)
		expect(session.isPanelOpen(westPanel)).toBe(false)
		expect(renderedKeys(container)).toEqual([`${formatPluginNodeRoute(east)}:bottom_one`])
		await setOwner(session, id)
		expect(renderedKeys(container)).toEqual([])
		expect(border(session, 'bottom').isShowing()).toBe(false)
	})
	it('restores open native tabs from snapshots but never invents closed tabs', async () => {
		const { session } = await fixture()
		const kept = panel('one', 'bottom'),
			closed = panel('two', 'bottom')
		await open(session, kept)
		await open(session, closed)
		await close(session, closed)
		await open(session, kept)
		const restored = new WorkspaceSession({ snapshot: session.workbench.snapshot() })
		sessions.push(restored)
		const id = restored.workbench.getDocuments()[0]!.id
		await setOwner(restored, id, east)
		expect(restored.isPanelOpen(kept)).toBe(true)
		expect(restored.isPanelOpen(closed)).toBe(false)
		expect(border(restored, 'bottom').getSelectedNode()?.getId()).toBe(panelId(kept))
		const fresh = new WorkspaceSession()
		sessions.push(fresh)
		const freshId = await openDocument(fresh, '/logs')
		await setOwner(fresh, freshId, east)
		expect(fresh.isPanelOpen(kept)).toBe(false)
		expect(border(fresh, 'bottom').isShowing()).toBe(false)
	})
	it('explicitly reopens a changed declaration in its new region and refreshes its title', async () => {
		const { session, container } = await fixture()
		const original = panel('one', 'bottom')
		await open(session, original)
		const changed: WorkbenchLayoutEntry = {
			...original,
			placement: { kind: 'panel', region: 'right', label: 'New placement', order: 0 },
		}
		await act(async () => {
			source.snapshot = compileWorkbenchSnapshot(null, {
				profile: 1,
				revision: 8,
				target: null,
				entries: [changed],
			})
			await session.syncWorkspacePanels([changed])
			session.notifyContentState()
		})
		expect(session.isPanelOpen(changed)).toBe(false)
		await open(session, changed)
		expect(session.isPanelOpen(changed)).toBe(true)
		expect(border(session, 'bottom').getChildren()).toHaveLength(0)
		expect(border(session, 'right').getSelectedNode()?.getId()).toBe(panelId(changed))
		expect(border(session, 'right').getSelectedNode()?.getName()).toBe('New placement')
		expect(renderedKeys(container)).toEqual([`${formatPluginNodeRoute(east)}:bottom_one`])
		const renamed = { ...changed, placement: { ...changed.placement, label: 'Renamed panel' } }
		await act(async () => session.syncWorkspacePanels([renamed]))
		await open(session, renamed)
		expect(border(session, 'right').getSelectedNode()?.getName()).toBe('Renamed panel')
	})
	it.each(['live-region', 'archive-region', 'archive-shape'] as const)(
		'rejects invalid %s snapshot before mounting or modifying it',
		async (corruption) => {
			const { session, id } = await fixture()
			const entry = panel('one', 'bottom')
			await open(session, entry)
			if (corruption !== 'live-region') await setOwner(session, id, west)
			const snapshot = structuredClone(session.workbench.snapshot())
			const bottom = snapshot.layout.borders!.find((item) => item.location === 'bottom')!
			if (corruption === 'live-region') {
				const misplaced = bottom.children!.pop()!
				snapshot.layout
					.borders!.find((item) => item.location === 'right')!
					.children!.push(misplaced)
			} else {
				const archives = bottom.config.panelArchives
				const key = panelIdentity(entry).owner
				if (corruption === 'archive-shape') archives[key].tabs = 'invalid'
				else archives[key].tabs[0].config.pluginPanel.region = 'right'
			}
			const before = JSON.stringify(snapshot)
			expect(() => new WorkspaceSession({ snapshot })).toThrow('工作区布局无法恢复')
			expect(JSON.stringify(snapshot)).toBe(before)
		},
	)
	it('reset writes an empty default layout with no archived owner panels', async () => {
		const { session, id } = await fixture()
		await open(session, panel('one', 'bottom'))
		await setOwner(session, id, west)
		await open(session, panel('one', 'right', west))
		const assign = vi.fn()
		vi.stubGlobal('location', { assign })
		await act(async () => {
			expect(await session.resetLayout()).toBe(true)
		})
		expect(assign).toHaveBeenCalledWith(session.basepath)
		const snapshot = session.storage.readSnapshot()
		expect(JSON.stringify(snapshot)).not.toContain('plugin-panel:')
		expect(JSON.stringify(snapshot)).not.toContain('panelArchives')
		const restored = new WorkspaceSession({ snapshot })
		sessions.push(restored)
		expect(restored.workbench.getDocuments()).toHaveLength(0)
		expect(border(restored, 'bottom').getChildren()).toHaveLength(0)
	})
	it('permits panel reordering only in its declared border and rejects stale or foreign entries', async () => {
		const { session } = await fixture()
		const entry = panel('one', 'bottom')
		await open(session, entry)
		expect(
			session.workbench.canDispatch(
				Actions.moveNode(panelId(entry), 'border_bottom', DockLocation.CENTER, 0),
			),
		).toBe(true)
		expect(
			session.workbench.canDispatch(
				Actions.moveNode(panelId(entry), 'border_right', DockLocation.CENTER, 0),
			),
		).toBe(false)
		expect(
			session.workbench.canDispatch(
				Actions.moveNode(panelId(entry), 'main', DockLocation.CENTER, 0),
			),
		).toBe(false)
		expect(
			session.workbench.canDispatch(
				Actions.addTab(panelTab(panel('one', 'left')), 'border_bottom', DockLocation.CENTER, -1),
			),
		).toBe(false)
		await expect(session.openPanel(panel('one', 'bottom', west))).rejects.toThrow('切回')
		await expect(session.openPanel(panel('missing', 'bottom'))).rejects.toThrow('扩展')
	})
	it('releases stopped owner resources and resumes only the explicitly open panel', async () => {
		const { session, container } = await fixture()
		const entry = panel('one', 'right')
		await open(session, entry)
		await act(async () => {
			source.runningPluginKeys.delete(pluginNodeIndexKey(east))
			session.notifyContentState()
		})
		expect(renderedKeys(container)).toEqual([])
		expect(container.textContent).toContain('插件未运行')
		expect(source.unmount).toHaveBeenCalledWith(`${formatPluginNodeRoute(east)}:right_one`)
		await act(async () => {
			source.runningPluginKeys.add(pluginNodeIndexKey(east))
			session.notifyContentState()
		})
		expect(renderedKeys(container)).toEqual([`${formatPluginNodeRoute(east)}:right_one`])
	})
})

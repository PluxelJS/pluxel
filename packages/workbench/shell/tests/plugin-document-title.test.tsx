// @vitest-environment jsdom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Actions } from 'flexlayout-react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PluginNodeAddress } from '@pluxel/core'
import { WorkspaceSession } from '../src/app/workbench/session'
import { buildPluginDetailHref } from '../src/workbench/paths'
import {
	openDocument,
	prepareNativeWorkbenchDom,
	renderWorkspace,
} from './helpers/native-workbench'

const state = vi.hoisted(() => ({ label: 'FontsPlugin' as string | undefined, refresh: () => {} }))
vi.mock('../src/app/plugins/detail/RightPane', () => ({ RightPane: () => null }))
vi.mock('../src/app/workbench/WorkspaceNavigation', () => ({ WorkspaceNavigation: () => null }))
vi.mock('../src/app/plugins/config/usePluginConfig', () => ({ usePluginConfig: () => ({}) }))
vi.mock('../src/app/plugins/detail/usePluginDetail', async () => {
	const { useState } = await import('react')
	return {
		usePluginDetail: () => {
			const [, setRevision] = useState(0)
			state.refresh = () => setRevision((value) => value + 1)
			return { detail: state.label ? { label: state.label } : undefined, ready: false }
		},
	}
})
const owner: PluginNodeAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@test/plugin-title' },
		exportName: 'FontsPlugin',
	},
	variant: 'default',
}
const roots: Root[] = []
const sessions: WorkspaceSession[] = []
beforeEach(() => {
	prepareNativeWorkbenchDom()
	state.label = 'FontsPlugin'
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
async function mount(snapshot?: unknown) {
	const session = new WorkspaceSession({ basepath: '/', snapshot })
	sessions.push(session)
	const view = await renderWorkspace(session)
	roots.push(view.root)
	let id: string
	if (snapshot === undefined) id = await openDocument(session, buildPluginDetailHref(owner))
	else {
		await act(async () => {
			const result = await session.workbench.start()
			if (result.status !== 'applied') throw new Error(JSON.stringify(result))
		})
		id = session.workbench.getActiveDocument()!.id
	}
	return { session, id, ...view }
}

it('updates automatic native titles on label refresh and preserves a subsequent user rename', async () => {
	const { session, id } = await mount()
	expect(session.workbench.getDocument(id)?.title).toBe('FontsPlugin')
	await act(async () => {
		state.label = 'Updated Fonts'
		state.refresh()
	})
	expect(session.workbench.getDocument(id)?.title).toBe('Updated Fonts')
	await act(async () => {
		await session.workbench.dispatch(Actions.renameTab(id, 'My font notes'))
	})
	await act(async () => {
		state.label = 'New server label'
		state.refresh()
	})
	expect(session.workbench.getDocument(id)?.title).toBe('My font notes')
})

it('starts native copies with automatic titles and restores the source manual title separately', async () => {
	const { session, id, root } = await mount()
	await act(async () => {
		await session.workbench.dispatch(Actions.renameTab(id, '我的字体配置'))
		await session.workbench.duplicate(id)
	})
	const copy = session.workbench.getActiveDocument()!
	expect(copy.id).not.toBe(id)
	expect(copy.title).toBe('FontsPlugin')
	expect(session.workbench.getDocument(id)?.title).toBe('我的字体配置')
	const snapshot = session.workbench.createSnapshot()
	await act(async () => {
		root.unmount()
		await session.dispose()
	})
	roots.splice(roots.indexOf(root), 1)
	const restored = await mount(snapshot)
	expect(restored.session.workbench.getDocuments()).toHaveLength(2)
	expect(restored.session.workbench.getActiveDocument()?.id).toBe(copy.id)
	expect(restored.session.workbench.getDocument(copy.id)?.title).toBe('FontsPlugin')
	expect(restored.session.workbench.getDocument(id)?.title).toBe('我的字体配置')
	await act(async () => {
		state.label = 'Renamed Fonts'
		state.refresh()
	})
	expect(restored.session.workbench.getDocument(copy.id)?.title).toBe('Renamed Fonts')
	expect(restored.session.workbench.getDocument(id)?.title).toBe('我的字体配置')
})

it('replaces the accepted native default when plugin details arrive after the route mounts', async () => {
	state.label = undefined
	const { session, id } = await mount()
	expect(session.workbench.getDocument(id)?.title).toBe('插件详情')
	await act(async () => {
		state.label = 'FontsPlugin'
		state.refresh()
	})
	expect(session.workbench.getDocument(id)?.title).toBe('FontsPlugin')
	await act(async () => state.refresh())
	expect(session.workbench.getDocument(id)?.title).toBe('FontsPlugin')
})

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { PluginScreen } from '../src/app/plugins/detail/PluginScreen'

const state = vi.hoisted(() => ({
	label: 'FontsPlugin',
	title: '插件详情',
	dispatch: vi.fn(async (_action: unknown) => ({ status: 'applied' })),
	refresh: () => {},
	document: { id: 'document' },
}))
vi.mock('@worksplit/react', () => ({
	useWorkbenchState: (_workbench: unknown, select: () => unknown) => select(),
}))
vi.mock('@mantine/core', () => ({ Stack: () => null, Skeleton: () => null }))
vi.mock('../src/components', () => ({ EmptyState: () => null, ErrorState: () => null }))
vi.mock('../src/app/plugins/detail/RightPane', () => ({ RightPane: () => null }))
vi.mock('../src/app/plugins/config/usePluginConfig', () => ({ usePluginConfig: () => ({}) }))
vi.mock('../src/app/plugins/detail/usePluginDetail', async () => {
	const { useState } = await import('react')
	return {
		usePluginDetail: () => {
			const [, setRevision] = useState(0)
			state.refresh = () => setRevision((value) => value + 1)
			return { detail: { label: state.label }, ready: false }
		},
	}
})
vi.mock('../src/app/router/useCurrentRoute', () => ({ useCurrentPathname: () => '/plugins/fonts' }))
vi.mock('../src/app/plugins/detail/pluginDetailSearchState', () => ({
	usePluginDetailSearch: () => ({}),
}))
vi.mock('../src/app/workbench/document', () => ({
	useDocumentWorkspace: () => {},
	useOptionalWorkbenchDocument: () => state.document,
}))
vi.mock('../src/app/workbench/workspaceContext', () => {
	const session = {
		workbench: { dispatch: state.dispatch, getDocument: () => ({ title: state.title }) },
		check: () => {},
		report: () => {},
	}
	return { useOptionalWorkspaceSession: () => session }
})
it('updates automatic titles for route or label changes without overwriting a user rename on detail refresh', async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
	const host = document.createElement('div')
	const root = createRoot(host)
	try {
		await act(async () => root.render(<PluginScreen pluginRoute="fonts" />))
		expect(state.dispatch).toHaveBeenCalledTimes(1)
		// A fresh detail object from status refresh must leave a manually renamed tab alone.
		state.dispatch.mockClear()
		await act(async () => state.refresh())
		expect(state.dispatch).not.toHaveBeenCalled()
		state.title = 'FontsPlugin'
		state.label = 'Updated Fonts'
		await act(async () => state.refresh())
		expect(state.dispatch).toHaveBeenCalledTimes(1)
		expect(state.dispatch.mock.calls[0]?.[0]).toMatchObject({
			data: { json: { name: 'Updated Fonts' } },
		})
		state.dispatch.mockClear()
		state.title = '插件详情'
		await act(async () => root.render(<PluginScreen pluginRoute="another-plugin" />))
		expect(state.dispatch).toHaveBeenCalledTimes(1)
		expect(state.dispatch.mock.calls[0]?.[0]).toMatchObject({
			data: { json: { helpText: 'another-plugin' } },
		})
	} finally {
		await act(async () => root.unmount())
	}
})

it('preserves a copied or restored custom title on initial mount and later label refresh', async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
	state.dispatch.mockClear()
	state.title = '我的字体配置'
	state.label = 'FontsPlugin'
	const root = createRoot(document.createElement('div'))
	try {
		await act(async () => root.render(<PluginScreen pluginRoute="fonts" />))
		expect(state.dispatch).not.toHaveBeenCalled()
		state.label = 'Renamed Fonts'
		await act(async () => state.refresh())
		expect(state.dispatch).not.toHaveBeenCalled()
	} finally {
		await act(async () => root.unmount())
	}
})

it('replaces the native default accepted after the route view first mounts', async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
	state.dispatch.mockClear()
	state.title = '插件'
	state.label = 'FontsPlugin'
	const root = createRoot(document.createElement('div'))
	try {
		await act(async () => root.render(<PluginScreen pluginRoute="fonts" />))
		expect(state.dispatch).not.toHaveBeenCalled()
		state.title = '插件详情'
		await act(async () => state.refresh())
		expect(state.dispatch).toHaveBeenCalledTimes(1)
		expect(state.dispatch.mock.calls[0]?.[0]).toMatchObject({
			data: { json: { name: 'FontsPlugin' } },
		})
		state.dispatch.mockClear()
		state.title = 'FontsPlugin'
		await act(async () => state.refresh())
		expect(state.dispatch).not.toHaveBeenCalled()
	} finally {
		await act(async () => root.unmount())
	}
})

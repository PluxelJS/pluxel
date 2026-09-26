import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
	isNarrow: false,
	rightPaneVisible: false,
	inspectMount: vi.fn(),
}))

vi.mock('@mantine/hooks', () => ({
	useMediaQuery: () => state.isNarrow,
}))

vi.mock('../src/app/workbench/split', () => ({
	DEFAULT_PLUGIN_WORKBENCH_HORIZONTAL_LAYOUT: { main: 70, aside: 30 },
	DEFAULT_PLUGIN_WORKBENCH_VERTICAL_LAYOUT: { content: 75, dock: 25 },
	PLUGIN_WORKBENCH_ASIDE_PANEL_ID: 'aside',
	PLUGIN_WORKBENCH_CONTENT_PANEL_ID: 'content',
	PLUGIN_WORKBENCH_DOCK_PANEL_ID: 'dock',
	PLUGIN_WORKBENCH_HORIZONTAL_LAYOUT_STORAGE_KEY: 'horizontal',
	PLUGIN_WORKBENCH_MAIN_PANEL_ID: 'main',
	PLUGIN_WORKBENCH_VERTICAL_LAYOUT_STORAGE_KEY: 'vertical',
	sanitizePluginWorkbenchHorizontalLayout: (value: unknown) => value,
	sanitizePluginWorkbenchVerticalLayout: (value: unknown) => value,
	WorkbenchSplitView: ({ panes }: { panes: readonly { id: string; children: ReactNode }[] }) => (
		<>
			{panes.map((pane) => (
				<span key={pane.id}>{pane.children}</span>
			))}
		</>
	),
	useStoredSplitLayout: (_key: string, fallback: Record<string, number>) => [fallback, vi.fn()],
	useSyncedLayout: () => undefined,
}))

vi.mock('../src/app/plugins/detail/RightPane', () => ({
	RightPane: () => null,
}))

vi.mock('../src/app/plugins/detail/workbench/PluginWorkbenchHostViews', () => ({
	PluginWorkbenchPanel: () => null,
	PluginWorkbenchSidebar: () => {
		state.inspectMount()
		return null
	},
}))

vi.mock('../src/app/plugins/detail/workbench/context', () => ({
	PluginWorkbenchAsideProvider: ({ children }: { children: ReactNode }) => children,
	usePluginWorkbenchLayout: () => ({
		dockVisible: false,
		rightPaneVisible: state.rightPaneVisible,
		setDockVisible: vi.fn(),
		setRightPaneVisible: vi.fn(),
	}),
}))

import { PluginWorkbench } from '../src/app/plugins/detail/workbench/PluginWorkbench'

describe('plugin dependency selection visibility', () => {
	beforeEach(() => {
		state.isNarrow = false
		state.rightPaneVisible = false
		state.inspectMount.mockClear()
	})

	it('does not mount sidebar inspection while the pane is collapsed', () => {
		renderToStaticMarkup(<PluginWorkbench config={{ loading: false, refetch: vi.fn() }} />)

		expect(state.inspectMount).not.toHaveBeenCalled()
	})

	it('does not mount sidebar inspection in the narrow single-pane layout', () => {
		state.isNarrow = true
		state.rightPaneVisible = true

		renderToStaticMarkup(<PluginWorkbench config={{ loading: false, refetch: vi.fn() }} />)

		expect(state.inspectMount).not.toHaveBeenCalled()
	})

	it('mounts sidebar inspection only when the desktop pane is visible', () => {
		state.rightPaneVisible = true

		renderToStaticMarkup(<PluginWorkbench config={{ loading: false, refetch: vi.fn() }} />)

		expect(state.inspectMount).toHaveBeenCalledOnce()
	})
})

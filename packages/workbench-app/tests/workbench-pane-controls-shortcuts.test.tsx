import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
	setDockVisible: vi.fn(),
	setLeftPaneVisible: vi.fn(),
	setRightPaneVisible: vi.fn(),
	toggleDock: vi.fn(),
	toggleLeftPane: vi.fn(),
	toggleRightPane: vi.fn(),
	useHotkey: vi.fn(),
	useHotkeySequence: vi.fn(),
}))

vi.mock('@tanstack/react-hotkeys', async (importOriginal) => ({
	...(await importOriginal<typeof import('@tanstack/react-hotkeys')>()),
	useHotkey: state.useHotkey,
	useHotkeySequence: state.useHotkeySequence,
}))

vi.mock('../src/app/workbench/context', () => ({
	useActiveWorkbenchTabId: () => 'active-tab',
	useWorkbenchLayout: () => ({
		leftPaneAvailable: true,
		leftPaneVisible: true,
		setLeftPaneVisible: state.setLeftPaneVisible,
		toggleLeftPane: state.toggleLeftPane,
	}),
}))

vi.mock('../src/app/plugins/detail/workbench/context', () => ({
	usePluginWorkbenchLayout: () => ({
		dockVisible: true,
		rightPaneVisible: true,
		setDockVisible: state.setDockVisible,
		setRightPaneVisible: state.setRightPaneVisible,
		toggleDock: state.toggleDock,
		toggleRightPane: state.toggleRightPane,
	}),
}))

import { WorkbenchPaneControls } from '../src/app/plugins/detail/controls/WorkbenchPaneControls'

describe('workbench pane control shortcuts', () => {
	beforeEach(() => {
		state.useHotkey.mockClear()
		state.useHotkeySequence.mockClear()
	})

	it('registers the VS Code panel bindings shown by the controls', () => {
		const markup = renderToStaticMarkup(<WorkbenchPaneControls />)

		expect(state.useHotkey).toHaveBeenCalledWith('Mod+K', expect.any(Function), {
			ignoreInputs: true,
			preventDefault: true,
			stopPropagation: false,
		})
		expect(state.useHotkey).toHaveBeenCalledWith('Mod+Alt+B', state.toggleRightPane, {
			ignoreInputs: true,
			preventDefault: true,
		})
		expect(state.useHotkey).toHaveBeenCalledWith('Mod+J', state.toggleDock, {
			ignoreInputs: true,
			preventDefault: true,
		})
		expect(state.useHotkeySequence).toHaveBeenCalledWith(['Mod+K', 'Z'], expect.any(Function), {
			ignoreInputs: true,
			preventDefault: true,
		})
		expect(markup).toContain('隐藏辅助侧栏 (Ctrl+Alt+B)')
		expect(markup).toContain('隐藏底部面板 (Ctrl+J)')
		expect(markup).toContain('聚焦工作区 (Ctrl+K Z)')
	})
})

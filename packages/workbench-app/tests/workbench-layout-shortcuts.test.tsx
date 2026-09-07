import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WorkbenchLayoutToggleButton } from '../src/app/workbench/LayoutControls'
import { WORKBENCH_HOTKEYS, WORKBENCH_HOTKEY_SEQUENCES } from '../src/app/workbench/shortcuts'

describe('workbench layout shortcuts', () => {
	it('follows the VS Code visibility keybindings without conflicting with quick open', () => {
		expect(WORKBENCH_HOTKEYS).toMatchObject({
			togglePluginRail: 'Mod+B',
			toggleDock: 'Mod+J',
			toggleRightPane: 'Mod+Alt+B',
			focusSearch: 'Mod+P',
		})
		expect(WORKBENCH_HOTKEY_SEQUENCES.toggleFocusMode).toEqual(['Mod+K', 'Z'])
	})

	it('renders a compact key hint that CSS can reveal when space permits', () => {
		const markup = renderToStaticMarkup(
			<WorkbenchLayoutToggleButton
				hiddenIcon={<span>hide</span>}
				hideLabel="隐藏插件列表"
				onClick={vi.fn()}
				shortcut="Ctrl+B"
				showIcon={<span>show</span>}
				showLabel="显示插件列表"
				visible
			/>,
		)

		expect(markup).toContain('title="隐藏插件列表 (Ctrl+B)"')
		expect(markup).toContain('class="plx-workbench__layoutShortcut">Ctrl+B</kbd>')
	})
})

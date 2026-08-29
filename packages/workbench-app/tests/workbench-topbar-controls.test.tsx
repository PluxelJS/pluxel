import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/theme', () => ({
	ColorSchemeToggle: ({ label }: { label: string }) => <button type="button" aria-label={label} />,
}))

vi.mock('../src/app/plugins/detail/controls/WorkbenchPaneControls', () => ({
	WorkbenchPaneControls: () => <span data-workbench-layout-controls="true" />,
}))

import {
	PluginQuickOpenAction,
	WorkbenchTopbarTools,
} from '../src/app/workbench/shell/WorkbenchShellViews'

describe('workbench topbar controls', () => {
	it('keeps appearance and workspace layout controls together on the leading side', () => {
		const markup = renderToStaticMarkup(<WorkbenchTopbarTools isPluginDetail />)

		const themeIndex = markup.indexOf('aria-label="切换工作台明暗模式"')
		const layoutIndex = markup.indexOf('data-workbench-layout-controls="true"')
		expect(themeIndex).toBeGreaterThan(-1)
		expect(layoutIndex).toBeGreaterThan(themeIndex)
	})

	it('has one plugin rail toggle source and leaves task actions on the trailing side', () => {
		const markup = renderToStaticMarkup(<PluginQuickOpenAction focusWorkbenchSearch={vi.fn()} />)

		expect(markup).toContain('aria-label="打开插件"')
		expect(markup).not.toContain('插件列表')
		expect(markup.match(/<button/g)).toHaveLength(1)
	})
})

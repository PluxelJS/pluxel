import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@pluxel/runtime/workbench/react', () => ({
	useWorkbench: () => ({
		api: Object.freeze({}),
		provider: Object.freeze({}),
		host: Object.freeze({ colorScheme: 'dark' }),
	}),
}))

import FontsManagerPanel from '../src/ui/manager.tsx'
import FontSelectionPanel from '../src/ui/selection.tsx'

describe('Fonts Workbench UI roots', () => {
	it.each([
		['manager', FontsManagerPanel, '服务端字体'],
		['selection attachment', FontSelectionPanel, '字体选择'],
	])('owns the Mantine context for the %s renderer', (_name, Renderer, expectedText) => {
		const markup = renderToStaticMarkup(createElement(Renderer))
		expect(markup).toContain(expectedText)
	})
})

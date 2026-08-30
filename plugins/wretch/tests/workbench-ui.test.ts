import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

vi.mock('@pluxel/runtime/workbench/react', () => ({
	useWorkbench: () => ({
		provider: Object.freeze({}),
		host: Object.freeze({ colorScheme: 'dark' }),
	}),
}))

import WretchSettingsPanel from '../src/ui/index.tsx'

it('owns the Mantine context for the Wretch Workbench renderer', () => {
	const markup = renderToStaticMarkup(createElement(WretchSettingsPanel))
	expect(markup).toContain('HTTP 设置')
})

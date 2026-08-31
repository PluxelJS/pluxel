import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

vi.mock('@pluxel/runtime/workbench/react', () => ({
	useWorkbench: () => ({
		api: Object.freeze({}),
		host: Object.freeze({ colorScheme: 'dark' }),
	}),
}))

import ManagerWorkbench from '../src/ui/index.tsx'

it('owns the Mantine context for the Package Manager Workbench renderer', () => {
	const markup = renderToStaticMarkup(createElement(ManagerWorkbench))
	expect(markup).toContain('Managed plugin packages')
})

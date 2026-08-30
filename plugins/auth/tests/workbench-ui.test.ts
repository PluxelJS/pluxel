import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

vi.mock('@pluxel/runtime/workbench/react', () => ({
	useWorkbench: () => ({
		api: Object.freeze({}),
		host: Object.freeze({ colorScheme: 'dark' }),
	}),
}))

import AuthSetup from '../src/ui/setup.tsx'

it('owns the Mantine context for the Auth Workbench renderer', () => {
	const markup = renderToStaticMarkup(createElement(AuthSetup))
	expect(markup).toContain('Authentication setup')
})

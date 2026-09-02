import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

vi.mock('@pluxel/runtime/workbench/react', () => ({
	createWorkbenchRenderer: () =>
		Object.freeze({
			render: (Component: unknown) => Component,
			useWorkbench: () => ({
				provider: Object.freeze({}),
				host: Object.freeze({ colorScheme: 'dark' }),
			}),
			query: () =>
				Object.freeze({
					useQuery: () =>
						Object.freeze({
							status: 'pending',
							data: undefined,
							error: null,
							isPending: true,
							isFetching: true,
							isStale: true,
							refetch: vi.fn(),
							invalidate: vi.fn(),
						}),
				}),
			mutation: () =>
				Object.freeze({
					useMutation: () =>
						Object.freeze({
							status: 'idle',
							isPending: false,
							data: undefined,
							error: null,
							mutate: vi.fn(),
							mutateAsync: vi.fn(),
							reset: vi.fn(),
						}),
				}),
		}),
}))

import WretchSettingsPanel from '../src/ui/index.tsx'

it('owns the Mantine context for the Wretch Workbench renderer', () => {
	const markup = renderToStaticMarkup(createElement(WretchSettingsPanel))
	expect(markup).toContain('HTTP 设置')
})

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

const { queryState } = vi.hoisted(() => ({ queryState: { data: undefined as unknown } }))

vi.mock('@pluxel/workbench/react', () => ({
	createWorkbenchRenderer: () =>
		Object.freeze({
			render: (Component: unknown) => Component,
			useWorkbench: () => ({
				api: Object.freeze({}),
				host: Object.freeze({ colorScheme: 'dark' }),
			}),
			query: () =>
				Object.freeze({
					useQuery: () =>
						Object.freeze({
							status: 'pending',
							data: queryState.data,
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

import ManagerWorkbench from '../src/ui/manager.tsx'

it('owns the Mantine context for the Package Manager Workbench renderer', () => {
	const markup = renderToStaticMarkup(createElement(ManagerWorkbench))
	expect(markup).toContain('Managed plugin packages')
})

it('keeps failed withdrawals visible with an explicit retry action', () => {
	queryState.data = {
		engine: 'test',
		rootDir: '/managed',
		entriesDir: '/managed/entries',
		packages: [],
		pendingRemovals: ['alpha'],
		dependenciesWithBuildScripts: [],
	}
	try {
		const markup = renderToStaticMarkup(createElement(ManagerWorkbench))
		expect(markup).toContain('Package removal needs retry')
		expect(markup).toContain('alpha')
		expect(markup).toContain('Retry removal')
	} finally {
		queryState.data = undefined
	}
})

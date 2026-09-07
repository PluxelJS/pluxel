import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const workbenchMocks = vi.hoisted(() => ({
	queryInvalidate: vi.fn(),
	mutationMutate: vi.fn(),
	mutationMutateAsync: vi.fn().mockResolvedValue(undefined),
	mutationReset: vi.fn(),
}))

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
							refetch: vi.fn().mockResolvedValue(undefined),
							invalidate: workbenchMocks.queryInvalidate,
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
							mutate: workbenchMocks.mutationMutate,
							mutateAsync: workbenchMocks.mutationMutateAsync,
							reset: workbenchMocks.mutationReset,
						}),
				}),
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

	it('clears a stale selection mutation error before refresh and retry', () => {
		type SelectionHandlers = Readonly<{
			onRefresh(): void
			onPreferredFamilyChange(family: string | null): void
		}>
		const panel = (FontSelectionPanel as () => ReactElement)()
		const content = (panel.props as Readonly<{ children: ReactElement<SelectionHandlers> }>)
			.children

		content.props.onRefresh()
		expect(workbenchMocks.mutationReset).toHaveBeenCalledOnce()
		expect(workbenchMocks.queryInvalidate).toHaveBeenCalledOnce()
		expect(workbenchMocks.mutationReset.mock.invocationCallOrder[0]).toBeLessThan(
			workbenchMocks.queryInvalidate.mock.invocationCallOrder[0]!,
		)

		workbenchMocks.mutationReset.mockClear()
		content.props.onPreferredFamilyChange('serif')
		expect(workbenchMocks.mutationReset).toHaveBeenCalledOnce()
		expect(workbenchMocks.mutationMutate).toHaveBeenCalledWith('serif')
		expect(workbenchMocks.mutationReset.mock.invocationCallOrder[0]).toBeLessThan(
			workbenchMocks.mutationMutate.mock.invocationCallOrder[0]!,
		)
	})
})

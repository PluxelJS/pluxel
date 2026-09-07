import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const viewSnapshot = Object.freeze({
	revision: 1,
	pluginName: 'PluginWithUI',
	startedAt: 0,
	counter: 0,
	events: Object.freeze([]),
	rendererProvider: 'renderer',
	storageProvider: 'storage',
	cacheProvider: 'cache',
	ratesProvider: 'rates',
	cache: Object.freeze({
		localHits: 0,
		backendHits: 0,
		misses: 0,
		loads: 0,
		deduplicated: 0,
		entries: 0,
	}),
	artifacts: Object.freeze([]),
})

vi.mock('@pluxel/runtime/workbench/react', () => ({
	createWorkbenchRenderer: (descriptor: Readonly<{ kind: string }>) => {
		let queryIndex = 0
		return Object.freeze({
			render: (Component: unknown) => Component,
			useWorkbench: () => ({
				api: Object.freeze({}),
				provider: Object.freeze({}),
				consumer: Object.freeze({}),
				host: Object.freeze({
					colorScheme: 'dark',
					document: Object.freeze({ setTitle: vi.fn() }),
					navigation: Object.freeze({ navigate: vi.fn() }),
					notify: vi.fn(),
				}),
			}),
			query: () => {
				const resourceIndex = queryIndex++
				return Object.freeze({
					useQuery: () =>
						Object.freeze({
							status: 'success',
							data:
								descriptor.kind === 'attachment'
									? resourceIndex === 0
										? Object.freeze([])
										: null
									: viewSnapshot,
							error: null,
							isPending: false,
							isFetching: false,
							isStale: false,
							refetch: vi.fn(),
							invalidate: vi.fn(),
						}),
				})
			},
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
		})
	},
}))

import FontSettings from './demo/PluginContributionFontDemo/ui/selection.tsx'
import Dashboard from './demo/PluginWithUI/ui/dashboard.tsx'
import Events from './demo/PluginWithUI/ui/events.tsx'
import Overview from './demo/PluginWithUI/ui/overview.tsx'
import ReportStudio from './showcase/ui/studio.tsx'

describe('plugin-host Workbench UI roots', () => {
	it.each([
		['PluginWithUI overview', Overview, 'PluginWithUI 概览'],
		['PluginWithUI events', Events, '插件事件'],
		['PluginWithUI dashboard', Dashboard, 'Dashboard'],
		['font attachment', FontSettings, 'Font Set'],
		['report studio', ReportStudio, 'Pluxel Architecture Lab'],
	])('owns the Mantine context for %s', (_name, Renderer, expectedText) => {
		const markup = renderToStaticMarkup(createElement(Renderer))
		expect(markup).toContain(expectedText)
	})
})

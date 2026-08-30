import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const snapshot = Object.freeze({
	revision: 1,
	pluginName: 'PluginWithUI',
	startedAt: 0,
	counter: 0,
	events: Object.freeze([]),
	rendererProvider: 'renderer',
	draftStorageProvider: 'drafts',
	releaseStorageProvider: 'releases',
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
	useRemoteValue: () => Object.freeze({ state: 'ready', value: snapshot }),
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
}))

import FontSettings from './demo/PluginContributionFontDemo/ui/index.tsx'
import Dashboard from './demo/PluginWithUI/ui/dashboard.tsx'
import Events from './demo/PluginWithUI/ui/events.tsx'
import Overview from './demo/PluginWithUI/ui/overview.tsx'
import ReportStudio from './showcase/ui/report-studio.tsx'

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

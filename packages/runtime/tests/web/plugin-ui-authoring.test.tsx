// @vitest-environment jsdom

import { act, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const signalDbCalls = vi.hoisted(() => ({
	docSelectors: [] as unknown[],
	queryDeps: [] as unknown[][],
	reset() {
		this.docSelectors = []
		this.queryDeps = []
	},
}))

vi.mock('../../src/web/plugin-ui/signaldb-runtime', () => ({
	useSignalDbCollectionState: vi.fn(() => ({
		name: 'mock',
		ready: true,
		version: 1,
		items: [],
		find: () => [],
		findOne: () => {},
		count: () => 0,
		insert: () => '1',
		insertMany: () => ['1'],
		updateOne: () => 0,
		replaceOne: () => 0,
		removeOne: () => 0,
		removeMany: () => 0,
	})),
	useSignalDbDocState: vi.fn((_transport, _pluginName, _collection, selector) => {
		signalDbCalls.docSelectors.push(selector)
		return undefined
	}),
	useSignalDbQueryState: vi.fn((query: () => unknown, deps?: unknown[]) => {
		signalDbCalls.queryDeps.push([...(deps ?? [])])
		return query()
	}),
}))

import { pluginUi } from '../../src/web/plugin-ui/authoring'
import {
	ExtensionProvider,
	type PluginExtensionContext,
} from '../../src/web/plugin-ui/ui-contracts'

const plugin = pluginUi('PluginWithUI')

function createPluginContext(): PluginExtensionContext {
	const transport: any = {
		extensions: { PluginWithUI: {} },
		sse: {
			ns: vi.fn(() => ({ on: vi.fn(), onAny: vi.fn() })),
		},
	}
	return {
		pluginName: 'PluginWithUI',
		pathname: '/plugins/PluginWithUI',
		colorScheme: 'light',
		runningPlugins: new Set(['PluginWithUI']),
		runningPluginsReady: true,
		services: {
			transport,
			ui: {
				notify: vi.fn(),
				confirm: vi.fn(async () => true),
			},
			locale: {
				locale: 'zh-CN',
				fallbackLocale: 'en',
				setLocale: vi.fn(),
				subscribe: vi.fn(() => () => {}),
				formatDate: vi.fn(() => ''),
				formatNumber: vi.fn(String),
			},
		},
	}
}

function Probe() {
	const app = plugin.use()
	app.db.useDocById('status', 'status')
	app.db.collection('events').useList({ sort: { at: -1 }, limit: 50 })
	app.db.useCount('events', {})

	const [tick, setTick] = useState(0)
	useEffect(() => {
		if (tick === 0) setTick(1)
	}, [tick])

	return <div data-tick={tick}>{app.pluginName}</div>
}

afterEach(() => {
	signalDbCalls.reset()
})

describe('pluginUi authoring', () => {
	it('stabilizes structured db inputs across rerenders', async () => {
		const container = document.createElement('div')
		document.body.appendChild(container)
		const root = createRoot(container)

		try {
			await act(async () => {
				root.render(
					<ExtensionProvider value={createPluginContext()}>
						<Probe />
					</ExtensionProvider>,
				)
				await Promise.resolve()
			})

			expect(signalDbCalls.docSelectors.length).toBeGreaterThanOrEqual(2)
			expect(signalDbCalls.docSelectors[0]).toBe(signalDbCalls.docSelectors[1])

			expect(signalDbCalls.queryDeps.length).toBeGreaterThanOrEqual(4)
			expect(signalDbCalls.queryDeps[0]?.[1]).toBe(signalDbCalls.queryDeps[2]?.[1])
			expect(signalDbCalls.queryDeps[1]?.[1]).toBe(signalDbCalls.queryDeps[3]?.[1])
		} finally {
			await act(async () => {
				root.unmount()
			})
			container.remove()
		}
	})
})

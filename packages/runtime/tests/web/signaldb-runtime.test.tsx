// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTransportClient } from '../../src/web/client'
import {
	type SignalDbCollectionView,
	useSignalDbCollectionState,
} from '../../src/web/plugin-ui/signaldb-runtime'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(assertion: () => void, timeoutMs = 2000) {
	const startedAt = Date.now()
	let lastError: unknown
	while (Date.now() - startedAt < timeoutMs) {
		try {
			assertion()
			return
		} catch (error) {
			lastError = error
			await act(async () => {
				await sleep(20)
			})
		}
	}
	if (lastError) throw lastError
	assertion()
}

function createSseStub(initialMessages: Array<{ payload: unknown }> = []) {
	return {
		ns: vi.fn(() => ({
			onAny: vi.fn((listener: (message: { payload: unknown }) => void) => {
				for (const message of initialMessages) listener(message)
				return () => {}
			}),
		})),
		onOpen: vi.fn(() => () => {}),
		close: vi.fn(),
	}
}

function createTransport(
	response: unknown | Promise<unknown>,
	options: { initialSseMessages?: Array<{ payload: unknown }> } = {},
) {
	const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === 'POST') {
			return new Response(JSON.stringify({ ok: false }), { status: 403 })
		}
		return new Response(JSON.stringify(await response), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	})
	const sse = createSseStub(options.initialSseMessages)
	return {
		transport: {
			fetch,
			links: {
				signaldbCollection: (pluginName: string, collection: string) =>
					`/__pluxel/runtime/signaldb/${pluginName}/${collection}`,
			},
			createSse: vi.fn(() => sse),
			dispose: vi.fn(),
		} as unknown as RuntimeTransportClient,
		fetch,
	}
}

describe('signaldb browser runtime', () => {
	it('treats read-only collections as local read-only and does not push empty sync changes', async () => {
		const { transport, fetch } = createTransport({
			items: [{ id: '1', value: 'server' }],
			meta: { clientWrites: false },
		})
		const container = document.createElement('div')
		const root = createRoot(container)
		let view: SignalDbCollectionView<{ id: string; value: string }> | undefined

		function Probe() {
			view = useSignalDbCollectionState<{ id: string; value: string }>(
				transport,
				'PluginWithUI',
				'events',
			)
			return <div data-ready={view.ready ? 'yes' : 'no'} />
		}

		try {
			await act(async () => {
				root.render(<Probe />)
			})
			await waitFor(() => expect(view?.ready).toBe(true))

			expect(view?.ready).toBe(true)
			expect(view?.clientWrites).toBe(false)
			expect(view?.items).toEqual([{ id: '1', value: 'server' }])
			expect(() => view?.insert({ id: 'local', value: 'client' })).toThrow(
				'does not allow client writes',
			)
			expect(fetch).not.toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ method: 'POST' }),
			)
		} finally {
			await act(async () => {
				root.unmount()
			})
			transport.dispose()
			container.remove()
		}
	})

	it('replays remote snapshots that arrive before the collection hook is mounted', async () => {
		let resolvePull: (response: unknown) => void = () => {}
		const delayedPull = new Promise<unknown>((resolve) => {
			resolvePull = resolve
		})
		const { transport } = createTransport(
			delayedPull,
			{
				initialSseMessages: [
					{
						payload: {
							type: 'snapshot',
							collection: 'events',
							version: 7,
							items: [{ id: 'early', value: 'snapshot' }],
						},
					},
				],
			},
		)
		const container = document.createElement('div')
		const root = createRoot(container)
		let view: SignalDbCollectionView<{ id: string; value: string }> | undefined

		function Probe() {
			view = useSignalDbCollectionState<{ id: string; value: string }>(
				transport,
				'PluginWithUI',
				'events',
			)
			return null
		}

		try {
			await act(async () => {
				root.render(<Probe />)
			})
			await waitFor(() =>
				expect(view?.items.some((item) => item.id === 'early')).toBe(true),
			)
		} finally {
			resolvePull({
				items: [{ id: 'early', value: 'snapshot' }],
				meta: { clientWrites: false },
			})
			await act(async () => {
				root.unmount()
			})
			transport.dispose()
			container.remove()
		}
	})
})

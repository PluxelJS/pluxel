// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTransportClient } from '../../src/web/client'
import { runRuntimeTransportCleanups } from '../../src/web/client-lifecycle'
import {
	type SignalDbCollectionView,
	useBoundSignalDbCollectionsState,
	useSignalDbCollectionState,
} from '../../src/management/collection-ui-runtime'

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

type SseTestMessage = { namespace: string; payload: unknown }

function createSseStub(initialMessages: SseTestMessage[] = []) {
	const listeners = new Set<(message: SseTestMessage) => void>()
	const namespaceListeners = new Map<string, Set<(message: SseTestMessage) => void>>()
	return {
		onAny: vi.fn((listener: (message: SseTestMessage) => void) => {
			listeners.add(listener)
			for (const message of initialMessages) listener(message)
			return () => listeners.delete(listener)
		}),
		ns: vi.fn((namespace: string) => ({
			onAny: vi.fn((listener: (message: SseTestMessage) => void) => {
				let registered = namespaceListeners.get(namespace)
				if (!registered) {
					registered = new Set()
					namespaceListeners.set(namespace, registered)
				}
				registered.add(listener)
				for (const message of initialMessages) {
					if (message.namespace === namespace) listener(message)
				}
				return () => registered?.delete(listener)
			}),
		})),
		onOpen: vi.fn(() => () => {}),
		onError: vi.fn(() => () => {}),
		close: vi.fn(),
		emit: (message: SseTestMessage) => {
			for (const listener of listeners) listener(message)
			for (const listener of namespaceListeners.get(message.namespace) ?? []) listener(message)
		},
	}
}

function createTransport(
	response: unknown | Promise<unknown>,
	options: { initialSseMessages?: SseTestMessage[] } = {},
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
	let transport: RuntimeTransportClient
	const dispose = vi.fn(() => runRuntimeTransportCleanups(transport))
	transport = {
		fetch,
		links: {
			managementCollection: (binding: string) =>
				`/__pluxel/runtime/management/resources/collection/${binding}`,
			managementCollectionEvents: (bindings: readonly string[]) =>
				`/__pluxel/runtime/management/resources/collections/events?${bindings
					.map((binding) => `binding=${binding}`)
					.join('&')}`,
		},
		management: { stream: vi.fn(() => sse) },
		createSse: vi.fn(() => sse),
		dispose,
	} as unknown as RuntimeTransportClient
	return {
		transport,
		fetch,
		sse,
	}
}

describe('signaldb browser runtime', () => {
	it('resolves each collection through its own opaque binding', async () => {
		const { transport, fetch } = createTransport({ items: [], meta: { clientWrites: false } })
		fetch.mockImplementation(async (input: RequestInfo | URL) => {
			const binding = String(input).split('/').at(-1)
			return new Response(
				JSON.stringify({
					items: [{ id: binding, value: binding }],
					meta: { clientWrites: false },
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		})
		const container = document.createElement('div')
		const root = createRoot(container)
		let views: Record<string, SignalDbCollectionView<any>> = {}

		function Probe() {
			views = useBoundSignalDbCollectionsState(transport, {
				settings: 'opaque-settings',
				status: 'opaque-status',
			})
			return null
		}

		try {
			await act(async () => {
				root.render(<Probe />)
			})
			await waitFor(() => {
				expect(views.settings?.items).toEqual([{ id: 'opaque-settings', value: 'opaque-settings' }])
				expect(views.status?.items).toEqual([{ id: 'opaque-status', value: 'opaque-status' }])
			})
			expect(transport.createSse).toHaveBeenCalledOnce()
			expect(transport.createSse).toHaveBeenCalledWith({
				url: expect.stringContaining('binding=opaque-settings&binding=opaque-status'),
			})
			expect(transport.management.stream).not.toHaveBeenCalled()
			expect(fetch).toHaveBeenCalledWith(
				expect.stringContaining('/opaque-settings'),
				expect.objectContaining({ method: 'GET' }),
			)
			expect(fetch).toHaveBeenCalledWith(
				expect.stringContaining('/opaque-status'),
				expect.objectContaining({ method: 'GET' }),
			)
		} finally {
			await act(async () => {
				root.unmount()
			})
			transport.dispose()
			container.remove()
		}
	})

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
		const { transport, sse } = createTransport(delayedPull, {
			initialSseMessages: [
				{
					namespace: 'PluginWithUI',
					payload: {
						type: 'snapshot',
						collection: 'events',
						version: 7,
						items: [{ id: 'early', value: 'snapshot' }],
					},
				},
			],
		})
		const container = document.createElement('div')
		const root = createRoot(container)
		let view: SignalDbCollectionView<{ id: string; value: string }> | undefined
		let unmounted = false
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

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
			await waitFor(() => expect(view?.items.some((item) => item.id === 'early')).toBe(true))
			await act(async () => {
				root.unmount()
			})
			unmounted = true
			sse.emit({
				namespace: 'PluginWithUI',
				payload: {
					type: 'snapshot',
					collection: 'events',
					version: 8,
					items: [{ id: 'late', value: 'during teardown' }],
				},
			})
			transport.dispose()
			resolvePull({ items: [], meta: { clientWrites: false } })
			await act(async () => {
				await sleep(30)
			})
			expect(
				consoleError.mock.calls.some((call) => String(call[0]).includes('remote change failed')),
			).toBe(false)
		} finally {
			resolvePull({
				items: [{ id: 'early', value: 'snapshot' }],
				meta: { clientWrites: false },
			})
			if (!unmounted) {
				await act(async () => {
					root.unmount()
				})
			}
			transport.dispose()
			consoleError.mockRestore()
			container.remove()
		}
	})
})

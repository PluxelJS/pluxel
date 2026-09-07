import { getWebSocketHooks } from 'crossws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeElysiaApplicationCarrier } from '../src/index'

describe('Node Elysia application carrier', () => {
	afterEach(() => vi.useRealTimers())

	it('force-settles an owner lease when a transport never emits close', async () => {
		vi.useFakeTimers()
		const carrier = new NodeElysiaApplicationCarrier({
			fetch: async () => new Response('unused'),
			matches: () => true,
			metadata: () => ({
				url: new URL('http://127.0.0.1:3000'),
				port: 3000,
				hostname: '127.0.0.1',
				development: false,
			}),
		})
		const request = new Request('http://local.test/socket', {
			headers: { connection: 'upgrade', upgrade: 'websocket' },
		})
		const owner = new AbortController()
		const release = vi.fn()
		const routeClose = vi.fn()
		expect(
			carrier.upgrade({
				request,
				upgradeRequest: request,
				ownerKey: 'owner-a',
				data: { message() {}, close: routeClose, context: {} },
				signal: owner.signal,
				release,
			}),
		).toBe(true)

		const hooks = getWebSocketHooks(request)!
		const peer = {
			topics: new Set<string>(),
			websocket: { readyState: 1, binaryType: 'nodebuffer' },
			bufferedAmount: 0,
			remoteAddress: '127.0.0.1',
			close: vi.fn(),
			terminate: vi.fn(),
			send: vi.fn(() => 0),
			ping: vi.fn(() => 0),
			publish: vi.fn(),
			subscribe(topic: string) {
				this.topics.add(topic)
			},
			unsubscribe(topic: string) {
				this.topics.delete(topic)
			},
		}
		await hooks.open?.(peer as never)
		expect(carrier.pending('owner-a')).toBe(1)

		owner.abort(new Error('owner stopped'))
		expect(peer.close).toHaveBeenCalledWith(1012, 'Service Restart')
		expect(release).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1_000)
		expect(peer.terminate).toHaveBeenCalledOnce()
		expect(release).toHaveBeenCalledOnce()
		expect(carrier.pending('owner-a')).toBe(0)

		await hooks.close?.(peer as never, { code: 1006, reason: '' })
		expect(release).toHaveBeenCalledOnce()
		expect(routeClose).not.toHaveBeenCalled()
		await carrier.close()
	})
})

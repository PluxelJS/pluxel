import { once } from 'node:events'
import type { AddressInfo } from 'node:net'

import { newWebSocketRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'

import { createWorkbenchWatch } from '@pluxel/workbench/server'

class WatchApi extends RpcTarget {
	readonly controller = new AbortController()
	readonly releaseSubscription = vi.fn()
	readonly subscribe = vi.fn((notify: (revision: number) => void): Disposable => {
		this.notify = notify
		return { [Symbol.dispose]: this.releaseSubscription }
	})
	notify: (revision: number) => void = () => {}

	watch(observer: (revision: number) => void | Promise<void>) {
		return createWorkbenchWatch({
			observer,
			signal: this.controller.signal,
			subscribe: this.subscribe,
		})
	}
}

async function connect(carrier: 'local' | 'websocket', api: WatchApi) {
	if (carrier === 'local') {
		const remote = new RpcStub(api)
		return { remote, close: async () => remote[Symbol.dispose]() }
	}
	const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
	await once(server, 'listening')
	server.on('connection', (socket) => {
		const session = newWebSocketRpcSession(socket as unknown as WebSocket, api)
		socket.once('close', () => session[Symbol.dispose]())
	})
	const address = server.address() as AddressInfo
	const socket = new WebSocket(`ws://127.0.0.1:${address.port}`)
	const remote = newWebSocketRpcSession<WatchApi>(socket)
	return {
		remote,
		close: async () => {
			remote[Symbol.dispose]()
			for (const client of server.clients) client.terminate()
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			})
		},
	}
}

function callback(handler: (revision: number) => void | Promise<void> = () => {}) {
	const dispose = vi.fn()
	const invoke = vi.fn(handler)
	return { observer: Object.assign(invoke, { [Symbol.dispose]: dispose }), invoke, dispose }
}

describe.each(['local', 'websocket'] as const)('Workbench watch over %s RPC', (carrier) => {
	it('retains the callback after registration and releases both resources on remote disposal', async () => {
		const api = new WatchApi()
		const connection = await connect(carrier, api)
		const sink = callback()
		try {
			const watch = await connection.remote.watch(sink.observer)
			expect(sink.dispose).not.toHaveBeenCalled()
			api.notify(1)
			await vi.waitFor(() => expect(sink.invoke).toHaveBeenCalledWith(1))
			watch[Symbol.dispose]()
			await vi.waitFor(() => expect(api.releaseSubscription).toHaveBeenCalledTimes(1))
			await vi.waitFor(() => expect(sink.dispose).toHaveBeenCalledTimes(1))
			api.notify(2)
			api.controller.abort()
			expect(sink.invoke).toHaveBeenCalledTimes(1)
			expect(api.releaseSubscription).toHaveBeenCalledTimes(1)
		} finally {
			await connection.close()
		}
	})

	it('serializes delivery and retains only the latest pending invalidation', async () => {
		const api = new WatchApi()
		const connection = await connect(carrier, api)
		let finishFirst!: () => void
		const pending = new Promise<void>((resolve) => {
			finishFirst = resolve
		})
		const sink = callback((revision) => (revision === 1 ? pending : undefined))
		try {
			using _watch = await connection.remote.watch(sink.observer)
			api.notify(1)
			await vi.waitFor(() => expect(sink.invoke).toHaveBeenCalledTimes(1))
			api.notify(2)
			api.notify(3)
			api.notify(4)
			expect(sink.invoke.mock.calls).toEqual([[1]])
			finishFirst()
			await vi.waitFor(() => expect(sink.invoke.mock.calls).toEqual([[1], [4]]))
		} finally {
			finishFirst()
			await connection.close()
		}
	})

	it('aborts while a callback is pending and drops queued invalidations', async () => {
		const api = new WatchApi()
		const connection = await connect(carrier, api)
		let finish!: () => void
		const pending = new Promise<void>((resolve) => {
			finish = resolve
		})
		const sink = callback(() => pending)
		try {
			using _watch = await connection.remote.watch(sink.observer)
			api.notify(1)
			await vi.waitFor(() => expect(sink.invoke).toHaveBeenCalledTimes(1))
			api.notify(2)
			api.controller.abort()
			expect(api.releaseSubscription).toHaveBeenCalledTimes(1)
			finish()
			await vi.waitFor(() => expect(sink.dispose).toHaveBeenCalledTimes(1))
			api.notify(3)
			expect(sink.invoke.mock.calls).toEqual([[1]])
		} finally {
			finish()
			await connection.close()
		}
	})

	it('closes the subscription when the remote callback fails', async () => {
		const api = new WatchApi()
		const connection = await connect(carrier, api)
		const sink = callback(async () => {
			throw new Error('observer unavailable')
		})
		try {
			using _watch = await connection.remote.watch(sink.observer)
			api.notify(1)
			await vi.waitFor(() => expect(api.releaseSubscription).toHaveBeenCalledTimes(1))
			await vi.waitFor(() => expect(sink.dispose).toHaveBeenCalledTimes(1))
			api.notify(2)
			expect(sink.invoke).toHaveBeenCalledTimes(1)
		} finally {
			await connection.close()
		}
	})
})

describe('Workbench watch registration', () => {
	it('rejects a plain callback before registering a resource it cannot own', () => {
		const sink = callback()
		const subscribe = vi.fn(() => ({ [Symbol.dispose]: vi.fn() }))
		expect(() =>
			createWorkbenchWatch({
				observer: sink.observer,
				signal: new AbortController().signal,
				subscribe,
			}),
		).toThrow(/Cap.n Web callback/)
		expect(subscribe).not.toHaveBeenCalled()
		expect(sink.dispose).not.toHaveBeenCalled()
	})

	it('rejects an already aborted owner before registering', async () => {
		const api = new WatchApi()
		api.controller.abort(new Error('entry closed'))
		using remote = new RpcStub(api)
		const sink = callback()
		await expect(remote.watch(sink.observer)).rejects.toThrow(/entry closed|abort/i)
		expect(api.subscribe).not.toHaveBeenCalled()
		await vi.waitFor(() => expect(sink.dispose).toHaveBeenCalledTimes(1))
	})

	it('releases the retained callback when registration throws', async () => {
		const api = new WatchApi()
		api.subscribe.mockImplementation(() => {
			throw new Error('registration failed')
		})
		using remote = new RpcStub(api)
		const sink = callback()
		await expect(remote.watch(sink.observer)).rejects.toThrow('registration failed')
		await vi.waitFor(() => expect(sink.dispose).toHaveBeenCalledTimes(1))
		expect(api.releaseSubscription).not.toHaveBeenCalled()
	})

	it('cleans a subscription returned after a synchronous owner abort', async () => {
		const api = new WatchApi()
		api.subscribe.mockImplementation((notify) => {
			api.notify = notify
			api.controller.abort()
			notify(1)
			return { [Symbol.dispose]: api.releaseSubscription }
		})
		using remote = new RpcStub(api)
		const sink = callback()
		using _watch = await remote.watch(sink.observer)
		expect(api.releaseSubscription).toHaveBeenCalledTimes(1)
		await vi.waitFor(() => expect(sink.dispose).toHaveBeenCalledTimes(1))
		expect(sink.invoke).not.toHaveBeenCalled()
	})

	it('delivers an invalidation emitted during registration', async () => {
		const api = new WatchApi()
		api.subscribe.mockImplementation((notify) => {
			notify(0)
			return { [Symbol.dispose]: api.releaseSubscription }
		})
		using remote = new RpcStub(api)
		const sink = callback()
		const watch = await remote.watch(sink.observer)
		await vi.waitFor(() => expect(sink.invoke).toHaveBeenCalledWith(0))
		watch[Symbol.dispose]()
		await vi.waitFor(() => expect(api.releaseSubscription).toHaveBeenCalledTimes(1))
		await vi.waitFor(() => expect(sink.dispose).toHaveBeenCalledTimes(1))
	})
})

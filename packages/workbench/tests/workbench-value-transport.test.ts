import { once } from 'node:events'
import type { AddressInfo } from 'node:net'

import { newWebSocketRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'

import { consumeWorkbenchValue } from '../src/workbench/client'
import { assertWorkbenchDto } from '@pluxel/workbench/server'

class UnexpectedCapability extends RpcTarget {
	constructor(private readonly released: () => void) {
		super()
	}

	ping(): string {
		return 'pong'
	}

	[Symbol.dispose](): void {
		this.released()
	}
}

class ValueApi extends RpcTarget {
	readonly source = { items: [{ title: 'original' }], revision: 1 }
	readonly releaseCapability = vi.fn()

	snapshotDto(): { items: { title: string }[]; revision: number } {
		assertWorkbenchDto(this.source)
		return this.source
	}

	invalidDto(): { item: RpcTarget } {
		const value = { item: new UnexpectedCapability(this.releaseCapability) }
		assertWorkbenchDto(value)
		return value
	}

	capability() {
		return new UnexpectedCapability(this.releaseCapability)
	}

	unexpectedCapability() {
		return { item: new UnexpectedCapability(this.releaseCapability) }
	}
}

async function connect(carrier: 'local' | 'websocket', api: ValueApi) {
	if (carrier === 'local') {
		const remote = new RpcStub(api)
		return { remote, close: async () => remote[Symbol.dispose]() }
	}

	const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
	await once(server, 'listening')
	server.on('connection', (socket) => {
		const remote = newWebSocketRpcSession(socket as unknown as WebSocket, api)
		socket.once('close', () => remote[Symbol.dispose]())
	})
	const address = server.address() as AddressInfo
	const socket = new WebSocket(`ws://127.0.0.1:${address.port}`)
	const remote = newWebSocketRpcSession<ValueApi>(socket)
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

function trackResultDisposal(value: object) {
	const descriptor = Object.getOwnPropertyDescriptor(value, Symbol.dispose)
	expect(descriptor).toMatchObject({ configurable: true, enumerable: false })
	expect(typeof descriptor?.value).toBe('function')
	const dispose = vi.fn(function (this: unknown) {
		descriptor!.value.call(this)
	})
	Object.defineProperty(value, Symbol.dispose, { ...descriptor, value: dispose })
	return dispose
}

describe.each(['local', 'websocket'] as const)(
	'Workbench value ownership over %s RPC',
	(carrier) => {
		it('consumes the decoded tree without copying or freezing server state and survives session close', async () => {
			const api = new ValueApi()
			const connection = await connect(carrier, api)
			let closed = false
			try {
				const decoded = await connection.remote.snapshotDto()
				const items = decoded.items
				const item = items[0]
				const dispose = trackResultDisposal(decoded)
				expect(decoded).not.toBe(api.source)
				expect(items).not.toBe(api.source.items)
				expect(item).not.toBe(api.source.items[0])

				const snapshot = consumeWorkbenchValue(decoded)
				expect(snapshot).toBe(decoded)
				expect(snapshot.items).toBe(items)
				expect(snapshot.items[0]).toBe(item)
				expect(Object.isFrozen(snapshot)).toBe(true)
				expect(Object.isFrozen(snapshot.items)).toBe(true)
				expect(Object.isFrozen(snapshot.items[0])).toBe(true)
				expect(Object.getOwnPropertySymbols(snapshot)).toEqual([])
				expect(dispose).toHaveBeenCalledTimes(1)

				expect(Object.isFrozen(api.source)).toBe(false)
				expect(Object.isFrozen(api.source.items)).toBe(false)
				expect(Object.isFrozen(api.source.items[0])).toBe(false)
				expect(Object.getOwnPropertySymbols(api.source)).toEqual([])
				api.source.items[0]!.title = 'server updated'
				api.source.revision++
				await connection.close()
				closed = true
				expect(snapshot).toEqual({ items: [{ title: 'original' }], revision: 1 })
				expect(dispose).toHaveBeenCalledTimes(1)
			} finally {
				if (!closed) await connection.close()
			}
		})

		it('rejects a capability at the producer DTO boundary before it is exported', async () => {
			const api = new ValueApi()
			const connection = await connect(carrier, api)
			try {
				await expect(connection.remote.invalidDto()).rejects.toThrow(/non-portable data/)
				expect(api.releaseCapability).not.toHaveBeenCalled()
			} finally {
				await connection.close()
			}
		})

		it('rejects a directly returned capability and releases it before the session closes', async () => {
			const api = new ValueApi()
			const connection = await connect(carrier, api)
			try {
				const capability = await connection.remote.capability()
				expect(capability).toBeInstanceOf(RpcStub)
				expect(Object.getOwnPropertyDescriptor(capability, Symbol.dispose)).toBeUndefined()
				expect(api.releaseCapability).not.toHaveBeenCalled()
				expect(() => consumeWorkbenchValue(capability)).toThrowError(
					expect.objectContaining({ code: 'WORKBENCH_NON_PORTABLE_VALUE' }),
				)
				await vi.waitFor(() => expect(api.releaseCapability).toHaveBeenCalledTimes(1))
			} finally {
				await connection.close()
			}
			expect(api.releaseCapability).toHaveBeenCalledTimes(1)
		})

		it('rejects an unexpected nested capability and releases it before the session closes', async () => {
			const api = new ValueApi()
			const connection = await connect(carrier, api)
			try {
				const decoded = await connection.remote.unexpectedCapability()
				const dispose = trackResultDisposal(decoded)
				expect(api.releaseCapability).not.toHaveBeenCalled()
				expect(() => consumeWorkbenchValue(decoded)).toThrowError(
					expect.objectContaining({ code: 'WORKBENCH_NON_PORTABLE_VALUE' }),
				)
				expect(dispose).toHaveBeenCalledTimes(1)
				await vi.waitFor(() => expect(api.releaseCapability).toHaveBeenCalledTimes(1))
			} finally {
				await connection.close()
			}
			expect(api.releaseCapability).toHaveBeenCalledTimes(1)
		})
	},
)

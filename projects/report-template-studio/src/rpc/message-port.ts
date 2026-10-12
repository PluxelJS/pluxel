import { RpcSession, type RpcTransportWithCustomEncoding, type RpcStub } from 'capnweb'
import type { DesktopApi } from '../shared/contracts.js'
import type { NativeDesktopApi } from './targets.js'
import { rpcError, RPC_SESSION_OPTIONS } from './errors.js'

/** Browser MessagePort, Node MessagePort, and Electron's event-style MessagePortMain. */
export interface StudioMessagePort {
	postMessage(message: unknown, transfer: []): void
	start?(): void
	close(): void
	addEventListener?(type: string, listener: (event: any) => void): void
	removeEventListener?(type: string, listener: (event: any) => void): void
	on?(type: string, listener: (...args: any[]) => void): unknown
	off?(type: string, listener: (...args: any[]) => void): unknown
}

export class StudioMessagePortTransport implements RpcTransportWithCustomEncoding {
	readonly encodingLevel = 'structuredClonable' as const
	#port: StudioMessagePort
	#queue: unknown[] = []
	#receiver?: { resolve(value: unknown): void; reject(reason: unknown): void }
	#failure?: unknown
	#closed = false
	#removeListeners: () => void

	constructor(port: StudioMessagePort) {
		this.#port = port
		const message = (value: unknown) => {
			if (this.#failure || this.#closed) return
			if (value === null) {
				this.shutdown(rpcError('CLOSED', 'Studio MessagePort connection closed'))
				return
			}
			if (this.#receiver) {
				const receiver = this.#receiver
				this.#receiver = undefined
				receiver.resolve(value)
			} else if (this.#queue.length < 128) this.#queue.push(value)
			else this.shutdown(rpcError('BUSY', 'Studio MessagePort receive queue is full'))
		}
		const fail = () => this.shutdown(rpcError('CLOSED', 'Studio MessagePort connection failed'))
		if (port.addEventListener) {
			const listener = (event: MessageEvent) => message(event.data)
			port.addEventListener('message', listener)
			port.addEventListener('messageerror', fail)
			port.addEventListener('close', fail)
			this.#removeListeners = () => {
				port.removeEventListener?.('message', listener)
				port.removeEventListener?.('messageerror', fail)
				port.removeEventListener?.('close', fail)
			}
		} else if (port.on) {
			// Electron wraps the payload in { data }; Node EventEmitter ports deliver it directly.
			const listener = (event: unknown) =>
				message(event && typeof event === 'object' && 'data' in event ? event.data : event)
			port.on('message', listener)
			port.on('messageerror', fail)
			port.on('close', fail)
			this.#removeListeners = () => {
				port.off?.('message', listener)
				port.off?.('messageerror', fail)
				port.off?.('close', fail)
			}
		} else throw new TypeError('Studio requires a MessagePort event API')
		port.start?.()
	}

	send(message: unknown): void {
		if (this.#closed)
			throw this.#failure ?? rpcError('CLOSED', 'Studio MessagePort connection closed')
		// MessagePort's second argument is an empty transfer list: preview buffers stay owned by the backend.
		this.#port.postMessage(message, [])
	}

	receive(): Promise<unknown> {
		if (this.#failure || this.#closed)
			return Promise.reject(
				this.#failure ?? rpcError('CLOSED', 'Studio MessagePort connection closed'),
			)
		if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift())
		if (this.#receiver)
			return Promise.reject(
				rpcError('PROTOCOL_ERROR', 'Concurrent transport receives are unsupported'),
			)
		return new Promise((resolve, reject) => {
			this.#receiver = { resolve, reject }
		})
	}

	/** Reject first so Cap'n Web can send its own abort message before the port is closed. */
	shutdown(reason: unknown): void {
		if (this.#failure || this.#closed) return
		this.#failure = reason
		this.#queue = []
		this.#receiver?.reject(reason)
		this.#receiver = undefined
	}

	abort(reason: unknown): void {
		if (this.#closed) return
		this.#failure ??= reason
		this.#closed = true
		this.#removeListeners()
		this.#receiver?.reject(this.#failure)
		this.#receiver = undefined
		this.#queue = []
		try {
			this.#port.postMessage(null, [])
		} catch {}
		this.#port.close()
	}
}

function connectPort<T extends DesktopApi>(port: StudioMessagePort) {
	const transport = new StudioMessagePortTransport(port)
	const session = new RpcSession<T>(transport, undefined, RPC_SESSION_OPTIONS)
	const api = session.getRemoteMain()
	let disconnected = false
	return {
		api,
		disconnect() {
			if (disconnected) return
			disconnected = true
			api[Symbol.dispose]()
			transport.abort(rpcError('CLOSED', 'Studio MessagePort client disconnected'))
		},
	}
}

export function createDesktopClient<T extends DesktopApi = DesktopApi>(
	port: StudioMessagePort,
): { api: RpcStub<T>; disconnect(): void } {
	return connectPort<T>(port)
}

/** Only the trusted main-process channel receives this capability. */
export function createNativeDesktopClient(port: StudioMessagePort): {
	api: RpcStub<NativeDesktopApi>
	disconnect(): void
} {
	return connectPort<NativeDesktopApi>(port)
}

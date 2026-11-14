import { RpcSession, type RpcStub, type RpcTarget, type RpcTransport } from 'capnweb'
import { type Socket } from 'node:net'

/** Transport budgets cover framing and queued bytes before Cap'n Web decodes a message. */
export const SCRIPT_SOCKET_FRAME_BYTES = 4 * 1024 * 1024
const QUEUED_BYTES = 8 * 1024 * 1024

/** Length-prefixed UTF-8 carrier. It contains no application command dispatch. */
export class ScriptSocketTransport implements RpcTransport {
	readonly #socket: Socket
	#buffer = Buffer.alloc(0)
	#messages: string[] = []
	#queuedBytes = 0
	#waiter?: { resolve(value: string): void; reject(reason: unknown): void }
	#closed?: Error
	#sendingBytes = 0
	constructor(socket: Socket) {
		this.#socket = socket
		socket.on('data', (chunk: Buffer) => this.#data(chunk))
		socket.on('error', (error) => this.#fail(error))
		socket.on('close', () => this.#fail(new Error('Script control socket closed')))
	}
	send(message: string): Promise<void> {
		if (this.#closed) return Promise.reject(this.#closed)
		const bytes = Buffer.from(message, 'utf8')
		if (
			bytes.length > SCRIPT_SOCKET_FRAME_BYTES ||
			this.#sendingBytes + bytes.length > QUEUED_BYTES
		) {
			const error = new Error('Script control transport send budget exceeded')
			this.abort(error)
			return Promise.reject(error)
		}
		const frame = Buffer.allocUnsafe(4 + bytes.length)
		frame.writeUInt32BE(bytes.length)
		bytes.copy(frame, 4)
		this.#sendingBytes += bytes.length
		return new Promise<void>((resolve, reject) => {
			// The write callback settles after the bytes leave Node's write queue, applying backpressure.
			this.#socket.write(frame, (error) => {
				this.#sendingBytes -= bytes.length
				if (error) {
					this.#fail(error)
					reject(error)
				} else resolve()
			})
		})
	}
	receive(): Promise<string> {
		const message = this.#messages.shift()
		if (message !== undefined) {
			this.#queuedBytes -= Buffer.byteLength(message)
			return Promise.resolve(message)
		}
		if (this.#closed) return Promise.reject(this.#closed)
		if (this.#waiter) return Promise.reject(new Error('Concurrent script transport receive'))
		return new Promise((resolve, reject) => {
			this.#waiter = { resolve, reject }
		})
	}
	abort(reason: unknown): void {
		this.#fail(reason instanceof Error ? reason : new Error(String(reason)))
		this.#socket.destroy()
	}
	#fail(error: Error): void {
		if (this.#closed) return
		this.#closed = error
		this.#waiter?.reject(error)
		this.#waiter = undefined
		this.#buffer = Buffer.alloc(0)
		this.#messages.length = 0
		this.#queuedBytes = 0
	}
	#data(chunk: Buffer): void {
		if (this.#closed) return
		if (this.#buffer.length + chunk.length + this.#queuedBytes > QUEUED_BYTES) {
			this.abort(new Error('Script control transport receive budget exceeded'))
			return
		}
		this.#buffer = Buffer.concat([this.#buffer, chunk])
		while (this.#buffer.length >= 4) {
			const length = this.#buffer.readUInt32BE(0)
			if (length > SCRIPT_SOCKET_FRAME_BYTES || length === 0) {
				this.abort(new Error('Script control transport frame budget exceeded'))
				return
			}
			if (this.#buffer.length < length + 4) return
			const bytes = this.#buffer.subarray(4, length + 4)
			let message: string
			try {
				message = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
			} catch {
				this.abort(new Error('Invalid script control UTF-8 frame'))
				return
			}
			this.#buffer = this.#buffer.subarray(length + 4)
			if (this.#waiter) {
				const waiter = this.#waiter
				this.#waiter = undefined
				waiter.resolve(message)
			} else {
				this.#messages.push(message)
				this.#queuedBytes += length
			}
		}
	}
}

/** Owns only this physical session. Closing does not close the target's execution owner. */
export function openScriptSocketSession<T extends RpcTarget>(
	socket: Socket,
	localMain?: RpcTarget,
): Readonly<{
	remote: RpcStub<T>
	close(): void
}> {
	const transport = new ScriptSocketTransport(socket)
	const session = new RpcSession<T>(transport, localMain)
	const remote = session.getRemoteMain()
	let closed = false
	return Object.freeze({
		remote,
		close() {
			if (closed) return
			closed = true
			try {
				remote[Symbol.dispose]()
			} finally {
				transport.abort(new Error('Script control session disposed'))
			}
		},
	})
}

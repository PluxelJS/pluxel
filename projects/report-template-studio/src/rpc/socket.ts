import type { Socket } from 'node:net'
import type { RpcTransport } from 'capnweb'
import { rpcError, RPC_MESSAGE_BYTES } from './errors.js'

const BUFFER_LIMIT = 2 * RPC_MESSAGE_BYTES
const MESSAGE_LIMIT = 128

/** One bounded string stream; framing belongs here, business dispatch belongs to Cap'n Web. */
export class StudioSocketTransport implements RpcTransport {
	#socket: Socket
	#header = Buffer.alloc(4)
	#headerOffset = 0
	#frame?: Buffer
	#frameOffset = 0
	#messages: { message: string; bytes: number }[] = []
	#messageBytes = 0
	#receiver?: { resolve(value: string): void; reject(reason: unknown): void }
	#writes = new Set<(reason: unknown) => void>()
	#writeBytes = 0
	#error?: Error
	#decoder = new TextDecoder('utf-8', { fatal: true })

	constructor(socket: Socket) {
		this.#socket = socket
		socket.on('data', (chunk: Buffer) => this.#data(chunk))
		socket.on('error', (error) =>
			this.abort(
				rpcError(
					'CLOSED',
					'Studio IPC connection failed; accepted writes may have completed',
					error,
				),
			),
		)
		socket.on('end', () =>
			this.abort(
				rpcError('CLOSED', 'Studio IPC connection ended; accepted writes may have completed'),
			),
		)
		socket.on('close', () =>
			this.abort(
				rpcError('CLOSED', 'Studio IPC connection closed; accepted writes may have completed'),
			),
		)
	}

	send(message: string): Promise<void> {
		if (this.#error) return Promise.reject(this.#error)
		const bytes = Buffer.byteLength(message, 'utf8')
		if (bytes === 0 || bytes > RPC_MESSAGE_BYTES)
			return Promise.reject(
				rpcError(
					'LIMIT_EXCEEDED',
					`Studio IPC messages must contain 1–${RPC_MESSAGE_BYTES} UTF-8 bytes`,
				),
			)
		if (this.#writeBytes + bytes + 4 > BUFFER_LIMIT)
			return Promise.reject(rpcError('BUSY', 'Studio IPC output buffer is full'))
		this.#writeBytes += bytes + 4
		const frame = Buffer.allocUnsafe(bytes + 4)
		frame.writeUInt32BE(bytes, 0)
		frame.write(message, 4, bytes, 'utf8')
		return new Promise<void>((resolve, reject) => {
			let settled = false
			const finish = (error?: unknown) => {
				if (settled) return
				settled = true
				this.#writes.delete(fail)
				this.#writeBytes -= bytes + 4
				if (error) reject(error)
				else resolve()
			}
			const fail = (reason: unknown) => finish(reason)
			this.#writes.add(fail)
			// The callback settles only after the write has left Node's bounded output queue.
			// Multiple writes remain ordered by the native stream; callers observe backpressure.
			this.#socket.write(frame, (error) => finish(error))
		})
	}

	receive(): Promise<string> {
		if (this.#error) return Promise.reject(this.#error)
		const queued = this.#messages.shift()
		if (queued) {
			this.#messageBytes -= queued.bytes
			return Promise.resolve(queued.message)
		}
		if (this.#receiver)
			return Promise.reject(
				rpcError('PROTOCOL_ERROR', 'Concurrent transport receives are unsupported'),
			)
		return new Promise((resolve, reject) => {
			this.#receiver = { resolve, reject }
		})
	}

	abort(reason: unknown): void {
		if (this.#error) return
		this.#error =
			reason instanceof Error ? reason : rpcError('CLOSED', 'Studio IPC connection closed', reason)
		this.#receiver?.reject(this.#error)
		this.#receiver = undefined
		for (const reject of this.#writes) reject(this.#error)
		this.#messages = []
		this.#messageBytes = 0
		this.#frame = undefined
		this.#socket.destroy()
	}

	#data(chunk: Buffer): void {
		if (this.#error) return
		try {
			let offset = 0
			while (offset < chunk.length) {
				if (!this.#frame) {
					const copied = Math.min(4 - this.#headerOffset, chunk.length - offset)
					chunk.copy(this.#header, this.#headerOffset, offset, offset + copied)
					this.#headerOffset += copied
					offset += copied
					if (this.#headerOffset < 4) continue
					const size = this.#header.readUInt32BE(0)
					if (size === 0 || size > RPC_MESSAGE_BYTES)
						throw rpcError('LIMIT_EXCEEDED', `Studio IPC frame exceeds ${RPC_MESSAGE_BYTES} bytes`)
					if (this.#messageBytes + size > BUFFER_LIMIT || this.#messages.length >= MESSAGE_LIMIT)
						throw rpcError('BUSY', 'Studio IPC receive buffer is full')
					this.#frame = Buffer.allocUnsafe(size)
					this.#frameOffset = 0
					this.#headerOffset = 0
				}
				const copied = Math.min(this.#frame.length - this.#frameOffset, chunk.length - offset)
				chunk.copy(this.#frame, this.#frameOffset, offset, offset + copied)
				this.#frameOffset += copied
				offset += copied
				if (this.#frameOffset < this.#frame.length) continue
				const bytes = this.#frame.length
				const message = this.#decoder.decode(this.#frame)
				this.#frame = undefined
				if (this.#receiver) {
					const receiver = this.#receiver
					this.#receiver = undefined
					receiver.resolve(message)
				} else {
					this.#messages.push({ message, bytes })
					this.#messageBytes += bytes
				}
			}
		} catch (error) {
			this.abort(error)
		}
	}
}

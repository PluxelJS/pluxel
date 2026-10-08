import { connect, type Socket } from 'node:net'
import { once } from 'node:events'
import { encodeJson, type Json, type NativeTransport } from '@embedded-launcher/sdk'
import type { HostDocumentStorage } from '@pluxel/host'

const FRAME_LIMIT = 1024 * 1024
const IN_FLIGHT_LIMIT = 64
type Dispatch = (json: string) => Promise<string>
export interface NativeEndpoint {
	socket: string
	instance: string
	profile: string
	token: string
}

/** One execution connection borrowed by successive Vite Hosts. */
export async function connectNative(endpoint: NativeEndpoint) {
	const socket = connect(endpoint.socket)
	await once(socket, 'connect')
	let sequence = 0
	let buffer = Buffer.alloc(0)
	let closed = false
	let accepting = true
	let active: { lease: string; dispatch: Dispatch } | undefined
	const incoming = new Set<Promise<void>>()
	const pending = new Map<
		string,
		{
			resolve: (value: Json) => void
			reject: (error: Error) => void
			cleanup: () => void
		}
	>()
	function send(value: unknown) {
		if (closed || socket.destroyed)
			throw new Error('Native connection unavailable; request not submitted')
		const payload = Buffer.from(encodeJson(value))
		if (socket.writableLength + payload.length > FRAME_LIMIT * 2)
			throw new Error('Native connection write queue full')
		const header = Buffer.alloc(4)
		header.writeUInt32BE(payload.length)
		socket.write(Buffer.concat([header, payload]))
	}
	function disconnect(error: Error) {
		if (closed) return
		closed = true
		active = undefined
		for (const request of pending.values()) {
			request.cleanup()
			request.reject(error)
		}
		pending.clear()
	}
	async function route(value: Record<string, unknown>) {
		if (typeof value.method === 'string') {
			if (!accepting || !active || incoming.size >= IN_FLIGHT_LIMIT) {
				send({
					jsonrpc: '2.0',
					id: value.id ?? null,
					error: { code: -32001, message: 'Plugin Host unavailable or busy' },
				})
				return
			}
			const target = active
			const result = JSON.parse(await target.dispatch(encodeJson(value)))
			// Preserve the result of an already accepted operation, including a committed write,
			// even if its Host was withdrawn while it ran. New requests use the new lease.
			send(result)
			return
		}
		if (typeof value.id !== 'string')
			throw new TypeError('Native response must have a string request ID')
		const request = pending.get(value.id)
		if (!request) throw new TypeError(`Unexpected native response ID: ${value.id}`)
		pending.delete(value.id)
		request.cleanup()
		if ('error' in value) {
			const detail = value.error as { message?: unknown; code?: unknown }
			request.reject(new Error(`Native ${String(detail.code)}: ${String(detail.message)}`))
		} else if ('result' in value) request.resolve(value.result as Json)
		else request.reject(new TypeError('Native response has neither result nor error'))
	}
	socket.on('data', (chunk: Buffer) => {
		try {
			buffer = Buffer.concat([buffer, chunk])
			while (buffer.length >= 4) {
				const length = buffer.readUInt32BE(0)
				if (!length || length > FRAME_LIMIT) throw new RangeError('Native frame length is invalid')
				if (buffer.length < length + 4) break
				const value: unknown = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'))
				buffer = buffer.subarray(length + 4)
				if (
					!value ||
					typeof value !== 'object' ||
					Array.isArray(value) ||
					(value as { jsonrpc?: unknown }).jsonrpc !== '2.0'
				)
					throw new TypeError('Invalid native JSON-RPC envelope')
				const work = route(value as Record<string, unknown>)
				incoming.add(work)
				void work
					.catch((error: unknown) =>
						socket.destroy(error instanceof Error ? error : new Error(String(error))),
					)
					.finally(() => incoming.delete(work))
			}
		} catch (error) {
			socket.destroy(error instanceof Error ? error : new Error(String(error)))
		}
	})
	socket.on('error', (error) =>
		disconnect(
			new Error('Native connection failed; accepted operation outcome unknown', { cause: error }),
		),
	)
	socket.on('close', () =>
		disconnect(new Error('Native disconnected; accepted operation outcome unknown')),
	)
	const transport: NativeTransport = {
		request(method, params, signal) {
			signal?.throwIfAborted()
			if (closed)
				return Promise.reject(new Error('Native connection unavailable; request not submitted'))
			if (pending.size >= IN_FLIGHT_LIMIT)
				return Promise.reject(new Error('Native in-flight request limit reached'))
			const id = `n:${++sequence}`
			return new Promise<Json>((resolve, reject) => {
				const cancel = () => {
					// Cancellation is cooperative. Keep waiting for the actual receipt; never overwrite
					// a committed side effect with a locally fabricated cancellation result.
					try {
						send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } })
					} catch (error) {
						socket.destroy(error instanceof Error ? error : new Error(String(error)))
					}
				}
				const cleanup = () => signal?.removeEventListener('abort', cancel)
				pending.set(id, { resolve, reject, cleanup })
				signal?.addEventListener('abort', cancel, { once: true })
				try {
					send({ jsonrpc: '2.0', id, method, params })
				} catch (error) {
					pending.delete(id)
					cleanup()
					reject(error)
				}
			})
		},
	}
	try {
		const hello = await transport.request('session.hello', {
			protocol: 1,
			role: 'executor',
			instance: endpoint.instance,
			profile: endpoint.profile,
			token: endpoint.token,
		})
		if (
			!hello ||
			typeof hello !== 'object' ||
			Array.isArray(hello) ||
			hello.protocol !== 1 ||
			hello.instance !== endpoint.instance ||
			hello.profile !== endpoint.profile ||
			typeof hello.session !== 'string'
		)
			throw new TypeError('Native handshake identity mismatch')
		return {
			session: hello.session,
			transport,
			attachHost({ lease, dispatch }: { lease: string; dispatch: Dispatch }) {
				if (closed || !accepting) throw new Error('Execution connection is closing')
				if (active) throw new Error('Previous Host lease has not been withdrawn')
				active = { lease, dispatch }
				return async () => {
					if (active?.lease === lease) active = undefined
				}
			},
			documentStorage(namespace: 'config' | 'state'): HostDocumentStorage {
				const check = (key: string) => {
					if (key !== `${namespace}.json`)
						throw new TypeError(`Unsupported ${namespace} document key: ${key}`)
				}
				const read = async (key: string) => {
					check(key)
					const result = await transport.request('storage.read', { key: namespace })
					if (
						!result ||
						typeof result !== 'object' ||
						Array.isArray(result) ||
						(result.document !== null && typeof result.document !== 'string')
					)
						throw new TypeError('Invalid document read receipt')
					const document = result.document
					return typeof document === 'string' ? document : undefined
				}
				return {
					getText: read,
					async stat(key) {
						return (await read(key)) === undefined ? undefined : {}
					},
					async put(key, document) {
						check(key)
						const result = await transport.request('storage.write', { key: namespace, document })
						if (
							!result ||
							typeof result !== 'object' ||
							Array.isArray(result) ||
							result.committed !== true
						)
							throw new Error('Native document write did not commit')
					},
				}
			},
			async close() {
				accepting = false
				active = undefined
				await Promise.allSettled(incoming)
				await endSocket(socket)
			},
		}
	} catch (error) {
		socket.destroy()
		throw error
	}
}

async function endSocket(socket: Socket) {
	if (socket.destroyed) return
	const closed = once(socket, 'close')
	socket.end()
	await closed
}

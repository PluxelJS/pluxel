import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import { getWebSocketHooks, setWebSocketHooks, type Hooks, type Peer } from 'crossws'
import nodeWebSocketAdapter from 'crossws/adapters/node'
import type {
	ElysiaCarrierMetadata,
	ElysiaCarrierRequestAddress,
	ElysiaApplicationCarrier,
	ElysiaWebSocketUpgrade,
} from '@pluxel/runtime/internal'
import { buildGlobalWSHandler, type ServerWebSocket, type WSConnectionData } from 'elysia/ws'
import { NodeRequest } from 'srvx/node'
import type { ServerRequest } from 'srvx'

const OWNER_CLOSE_CODE = 1012
const OWNER_CLOSE_REASON = 'Service Restart'
const CARRIER_CLOSE_CODE = 1001
const CARRIER_CLOSE_REASON = 'Server Shutdown'
const HANDSHAKE_TIMEOUT_MS = 10_000
const FORCE_CLOSE_TIMEOUT_MS = 1_000

type UpgradeState = {
	ownerKey: string
	peer?: Peer
	opened: boolean
	activated: boolean
	settled: boolean
	forced: boolean
	handshakeTimer?: ReturnType<typeof setTimeout>
	forceTimer?: ReturnType<typeof setTimeout>
	release(): void
}

export interface NodeElysiaApplicationCarrierOptions {
	fetch(request: Request): Response | Promise<Response>
	matches(request: Request): boolean
	metadata(): ElysiaCarrierMetadata
}

/** Node/crossws binding for Runtime's platform-neutral Elysia application carrier contract. */
export class NodeElysiaApplicationCarrier implements ElysiaApplicationCarrier {
	private readonly globalHandler = buildGlobalWSHandler()
	private readonly sockets = new WeakMap<Peer, ServerWebSocket<WSConnectionData>>()
	private readonly peersByOwner = new Map<string, Set<Peer>>()
	private readonly requestOrigins = new WeakMap<Request, Request>()
	private readonly matchedUpgradeRequests = new WeakMap<IncomingMessage, Request>()
	private accepting = true

	readonly adapter = nodeWebSocketAdapter({
		resolve: (request) => this.resolve(request),
	})

	constructor(private readonly options: NodeElysiaApplicationCarrierOptions) {}

	get metadata(): ElysiaCarrierMetadata {
		return this.options.metadata()
	}

	upgrade(input: ElysiaWebSocketUpgrade): boolean {
		if (!this.accepting || !isConnectionData(input.data)) return false

		const state: UpgradeState = {
			ownerKey: input.ownerKey,
			opened: false,
			activated: false,
			settled: false,
			forced: false,
			release: () => {
				if (state.settled) return
				state.settled = true
				if (state.handshakeTimer) clearTimeout(state.handshakeTimer)
				if (state.forceTimer) clearTimeout(state.forceTimer)
				input.signal.removeEventListener('abort', abort)
				input.release()
			},
		}
		const abort = () => {
			if (!state.peer) {
				state.release()
				return
			}
			this.closePeer(state, OWNER_CLOSE_CODE, OWNER_CLOSE_REASON)
		}

		const hooks = this.connectionHooks(input, state)
		setWebSocketHooks(input.request, hooks)
		if (input.upgradeRequest !== input.request) {
			setWebSocketHooks(input.upgradeRequest, hooks)
		}
		if (getWebSocketHooks(input.request) !== hooks) return false

		state.handshakeTimer = setTimeout(() => {
			if (!state.opened) state.release()
		}, HANDSHAKE_TIMEOUT_MS)
		state.handshakeTimer.unref?.()
		input.signal.addEventListener('abort', abort, { once: true })
		if (input.signal.aborted) abort()
		return true
	}

	publish(
		ownerKey: string,
		topic: string,
		data: string | ArrayBufferView | ArrayBufferLike,
		compress?: boolean,
	): number {
		const peers = this.peersByOwner.get(ownerKey)
		if (!peers) return 0
		const physicalTopic = scopeTopic(ownerKey, topic)
		let sent = 0
		let backpressure = false
		for (const peer of peers) {
			if (!peer.topics.has(physicalTopic)) continue
			const status = sendPeer(peer, data, compress)
			if (status < 0) backpressure = true
			else sent += status
		}
		return backpressure ? -1 : sent
	}

	pending(ownerKey: string): number {
		return this.peersByOwner.get(ownerKey)?.size ?? 0
	}

	requestIP(request: Request): ElysiaCarrierRequestAddress | null {
		const source = (this.requestOrigins.get(request) ?? request) as ServerRequest
		const socket = source.runtime?.node?.req.socket
		if (!socket) {
			throw new Error(
				'[runtime-node] server.requestIP() requires a Request originating from the srvx Node carrier',
			)
		}
		if (!socket.remoteAddress || socket.remotePort === undefined) return null
		return {
			address: socket.remoteAddress,
			port: socket.remotePort,
			family: socket.remoteFamily === 'IPv6' ? 'IPv6' : 'IPv4',
		}
	}

	bindRequest(derived: Request, source: Request): void {
		this.requestOrigins.set(derived, source)
	}

	matchesUpgrade(request: IncomingMessage): boolean {
		if (!this.accepting) return false
		const webRequest = new NodeRequest({ req: request })
		const matches = this.options.matches(webRequest)
		if (matches) this.matchedUpgradeRequests.set(request, webRequest)
		return matches
	}

	handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		if (!this.accepting) {
			socket.destroy()
			return
		}
		const matchedRequest = this.matchedUpgradeRequests.get(request)
		let webRequest = matchedRequest
		if (matchedRequest) {
			this.matchedUpgradeRequests.delete(request)
		} else {
			webRequest = new NodeRequest({ req: request })
		}
		if (!matchedRequest && !this.options.matches(webRequest)) {
			socket.destroy()
			return
		}
		void this.adapter.handleUpgrade(request, socket, head, webRequest).catch(() => socket.destroy())
	}

	stopAccepting(): void {
		this.accepting = false
	}

	async close(): Promise<void> {
		this.stopAccepting()
		await this.adapter.close(CARRIER_CLOSE_CODE, CARRIER_CLOSE_REASON)
	}

	private async resolve(request: Request): Promise<Partial<Hooks>> {
		if (!this.accepting) {
			return { upgrade: () => new Response('Server shutting down', { status: 503 }) }
		}
		const response = await this.options.fetch(request)
		const hooks = getWebSocketHooks(request)
		if (hooks) {
			await response.body?.cancel().catch((): undefined => undefined)
			return hooks
		}
		return { upgrade: () => response }
	}

	private connectionHooks(input: ElysiaWebSocketUpgrade, state: UpgradeState): Partial<Hooks> {
		const data = input.data as WSConnectionData
		return {
			upgrade: () => ({
				headers: input.headers,
				namespace: input.ownerKey,
				context: { pluxelOwner: input.ownerKey },
			}),
			open: (peer) => {
				state.opened = true
				state.peer = peer
				if (state.handshakeTimer) clearTimeout(state.handshakeTimer)
				if (state.settled || input.signal.aborted) {
					this.closePeer(state, OWNER_CLOSE_CODE, OWNER_CLOSE_REASON)
					return
				}
				state.activated = true
				this.ownerPeers(input.ownerKey).add(peer)
				return this.globalHandler.open?.(this.socket(peer, data, input.ownerKey))
			},
			message: (peer, message) =>
				this.globalHandler.message(
					this.socket(peer, data, input.ownerKey),
					message.data as string | Buffer,
				),
			drain: (peer) => this.globalHandler.drain?.(this.socket(peer, data, input.ownerKey)),
			close: async (peer, details) => {
				this.removePeer(input.ownerKey, peer)
				try {
					if (state.activated && !state.forced) {
						await this.globalHandler.close?.(
							this.socket(peer, data, input.ownerKey),
							details.code ?? 1000,
							details.reason ?? '',
						)
					}
				} finally {
					state.release()
				}
			},
			error: (peer) => {
				if (!state.peer) state.peer = peer
				this.closePeer(state, 1011, 'Transport Error')
			},
			ping: (peer, payload) =>
				this.globalHandler.ping?.(this.socket(peer, data, input.ownerKey), Buffer.from(payload)),
			pong: (peer, payload) =>
				this.globalHandler.pong?.(this.socket(peer, data, input.ownerKey), Buffer.from(payload)),
		}
	}

	private socket(
		peer: Peer,
		data: WSConnectionData,
		ownerKey: string,
	): ServerWebSocket<WSConnectionData> {
		const cached = this.sockets.get(peer)
		if (cached) return cached

		let socket: ServerWebSocket<WSConnectionData>
		socket = {
			data,
			send: (value, compress) => sendPeer(peer, value, compress),
			sendText: (value, compress) => sendPeer(peer, value, compress),
			sendBinary: (value, compress) => sendPeer(peer, value, compress),
			close: (code, reason) => peer.close(code, reason),
			terminate: () => peer.terminate(),
			ping: (value) => pingPeer(peer, value),
			pong: () => unsupported('WebSocket pong'),
			publish: (topic, value, compress) =>
				publishPeer(peer, scopeTopic(ownerKey, topic), value, compress),
			publishText: (topic, value, compress) =>
				publishPeer(peer, scopeTopic(ownerKey, topic), value, compress),
			publishBinary: (topic, value, compress) =>
				publishPeer(peer, scopeTopic(ownerKey, topic), value, compress),
			subscribe: (topic) => peer.subscribe(scopeTopic(ownerKey, topic)),
			unsubscribe: (topic) => peer.unsubscribe(scopeTopic(ownerKey, topic)),
			isSubscribed: (topic) => peer.topics.has(scopeTopic(ownerKey, topic)),
			get subscriptions() {
				const prefix = scopeTopic(ownerKey, '')
				return [...peer.topics]
					.filter((topic) => topic.startsWith(prefix))
					.map((topic) => topic.slice(prefix.length))
			},
			cork: (callback) => callback(socket),
			get remoteAddress() {
				return peer.remoteAddress ?? ''
			},
			get readyState() {
				return (peer.websocket.readyState ?? 1) as 0 | 1 | 2 | 3
			},
			get binaryType() {
				return peer.websocket.binaryType as 'nodebuffer' | 'arraybuffer' | 'uint8array' | undefined
			},
			set binaryType(value) {
				peer.websocket.binaryType = value === 'uint8array' ? 'arraybuffer' : value
			},
		}
		this.sockets.set(peer, socket)
		return socket
	}

	private ownerPeers(ownerKey: string): Set<Peer> {
		let peers = this.peersByOwner.get(ownerKey)
		if (!peers) {
			peers = new Set()
			this.peersByOwner.set(ownerKey, peers)
		}
		return peers
	}

	private removePeer(ownerKey: string, peer: Peer): void {
		const peers = this.peersByOwner.get(ownerKey)
		if (!peers) return
		peers.delete(peer)
		if (peers.size === 0) this.peersByOwner.delete(ownerKey)
	}

	private closePeer(state: UpgradeState, code: number, reason: string): void {
		const peer = state.peer
		if (!peer) return
		peer.close(code, reason)
		state.forceTimer ??= setTimeout(() => {
			if (state.settled) return
			state.forced = true
			peer.terminate()
			this.removePeer(state.ownerKey, peer)
			state.release()
		}, FORCE_CLOSE_TIMEOUT_MS)
		state.forceTimer.unref?.()
	}
}

function isConnectionData(value: unknown): value is WSConnectionData {
	return value !== null && typeof value === 'object'
}

function scopeTopic(ownerKey: string, topic: string): string {
	return `pluxel:${encodeURIComponent(ownerKey)}:${topic}`
}

function isOpen(peer: Peer): boolean {
	return peer.websocket.readyState === undefined || peer.websocket.readyState === 1
}

function sendPeer(
	peer: Peer,
	data: string | ArrayBufferView | ArrayBufferLike,
	compress?: boolean,
): number {
	if (!isOpen(peer)) return 0
	peer.send(data, { compress })
	return peer.bufferedAmount > 0 ? -1 : payloadByteLength(data)
}

function pingPeer(peer: Peer, data?: string | ArrayBufferView | ArrayBufferLike): number {
	if (!isOpen(peer)) return 0
	peer.ping(data)
	return peer.bufferedAmount > 0 ? -1 : payloadByteLength(data ?? '')
}

function publishPeer(
	peer: Peer,
	topic: string,
	data: string | ArrayBufferView | ArrayBufferLike,
	compress?: boolean,
): number {
	if (!isOpen(peer)) return 0
	peer.publish(topic, data, { compress })
	return peer.bufferedAmount > 0 ? -1 : payloadByteLength(data)
}

function payloadByteLength(value: string | ArrayBufferView | ArrayBufferLike): number {
	if (typeof value === 'string') return Buffer.byteLength(value)
	return ArrayBuffer.isView(value) ? value.byteLength : value.byteLength
}

function unsupported(operation: string): never {
	throw new Error(`[runtime-node] ${operation} is not exposed by crossws on Node`)
}

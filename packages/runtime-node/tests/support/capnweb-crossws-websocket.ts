import { Buffer } from 'node:buffer'

import type { Message, Peer, WSError } from 'crossws'

type CapnwebWebSocketEventName = 'open' | 'message' | 'close' | 'error'

export type CapnwebCrosswsLimitKind =
	| 'inbound-message-bytes'
	| 'outbound-message-bytes'
	| 'outbound-queued-bytes'

export interface CapnwebCrosswsLimitViolation {
	kind: CapnwebCrosswsLimitKind
	actualBytes: number
	limitBytes: number
}

export interface CapnwebCrosswsWebSocketOptions {
	maxMessageBytes: number
	maxQueuedBytes: number
	onLimitViolation?(violation: CapnwebCrosswsLimitViolation): void
}

const MESSAGE_TOO_BIG = 1009

/**
 * Test-only seam between crossws' hook-driven Peer and the small DOM WebSocket
 * surface consumed by Cap'n Web 0.5.
 *
 * Raw message and observable send-queue ceilings belong here (with a parser-level
 * maxPayload above it). Semantic RPC concurrency and scheduling are not visible at
 * this layer and must be enforced around the exported RpcTarget instead.
 */
export class CapnwebCrosswsWebSocket {
	private readonly listeners = new Map<
		CapnwebWebSocketEventName,
		Set<EventListenerOrEventListenerObject>
	>()
	private peerClosed = false

	readonly webSocket: WebSocket

	constructor(
		private readonly peer: Peer,
		private readonly options: CapnwebCrosswsWebSocketOptions,
	) {
		const readyState = () =>
			this.peerClosed ? WebSocket.CLOSED : (this.peer.websocket.readyState ?? WebSocket.OPEN)
		this.webSocket = {
			get readyState() {
				return readyState()
			},
			addEventListener: (type: string, listener: EventListenerOrEventListenerObject | null) =>
				this.addEventListener(type, listener),
			removeEventListener: (type: string, listener: EventListenerOrEventListenerObject | null) =>
				this.removeEventListener(type, listener),
			send: (data) => this.send(data),
			close: (code, reason) => this.peer.close(code, reason),
		} as WebSocket
	}

	receive(message: Message): void {
		if (typeof message.rawData !== 'string') {
			this.peer.close(1003, "Cap'n Web requires text messages")
			return
		}

		const actualBytes = Buffer.byteLength(message.rawData)
		if (actualBytes > this.options.maxMessageBytes) {
			this.rejectLimit({
				kind: 'inbound-message-bytes',
				actualBytes,
				limitBytes: this.options.maxMessageBytes,
			})
			return
		}

		this.dispatch('message', { data: message.rawData })
	}

	closed(code = 1000, reason = ''): void {
		if (this.peerClosed) return
		this.peerClosed = true
		this.dispatch('close', { code, reason })
	}

	errored(error: WSError): void {
		this.dispatch('error', { error })
	}

	private send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		if (typeof data !== 'string') {
			throw new TypeError("Cap'n Web's WebSocket transport only sends text messages")
		}

		const messageBytes = Buffer.byteLength(data)
		if (messageBytes > this.options.maxMessageBytes) {
			this.rejectLimit({
				kind: 'outbound-message-bytes',
				actualBytes: messageBytes,
				limitBytes: this.options.maxMessageBytes,
			})
			throw new Error("Cap'n Web outbound message exceeds the configured byte ceiling")
		}

		const projectedQueuedBytes = this.peer.bufferedAmount + messageBytes
		if (projectedQueuedBytes > this.options.maxQueuedBytes) {
			this.rejectLimit({
				kind: 'outbound-queued-bytes',
				actualBytes: projectedQueuedBytes,
				limitBytes: this.options.maxQueuedBytes,
			})
			throw new Error("Cap'n Web outbound queue exceeds the configured byte ceiling")
		}

		this.peer.send(data)
		if (this.peer.bufferedAmount > this.options.maxQueuedBytes) {
			this.rejectLimit({
				kind: 'outbound-queued-bytes',
				actualBytes: this.peer.bufferedAmount,
				limitBytes: this.options.maxQueuedBytes,
			})
			throw new Error("Cap'n Web outbound queue exceeds the configured byte ceiling")
		}
	}

	private rejectLimit(violation: CapnwebCrosswsLimitViolation): void {
		this.options.onLimitViolation?.(violation)
		this.peer.close(MESSAGE_TOO_BIG, `${violation.kind} exceeded`)
	}

	private addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
	): void {
		if (!isSupportedEvent(type) || listener === null) return
		let listeners = this.listeners.get(type)
		if (!listeners) {
			listeners = new Set()
			this.listeners.set(type, listeners)
		}
		listeners.add(listener)
	}

	private removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
	): void {
		if (!isSupportedEvent(type) || listener === null) return
		this.listeners.get(type)?.delete(listener)
	}

	private dispatch(type: CapnwebWebSocketEventName, detail: Record<string, unknown>): void {
		const event = { type, target: this.webSocket, ...detail } as unknown as Event
		for (const listener of this.listeners.get(type) ?? []) {
			if (typeof listener === 'function') listener(event)
			else listener.handleEvent(event)
		}
	}
}

function isSupportedEvent(type: string): type is CapnwebWebSocketEventName {
	return type === 'open' || type === 'message' || type === 'close' || type === 'error'
}

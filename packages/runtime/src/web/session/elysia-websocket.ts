import type { ElysiaWS } from 'elysia/ws'

type CapnwebWebSocketEventName = 'close' | 'error' | 'message' | 'open'

export type RuntimeSessionLimitKind =
	| 'inbound-message-bytes'
	| 'outbound-message-bytes'
	| 'outbound-queue'

export type RuntimeSessionLimitViolation = Readonly<{
	kind: RuntimeSessionLimitKind
	actualBytes: number
	limitBytes: number
}>

export type RuntimeSessionWebSocketOptions = Readonly<{
	maxMessageBytes: number
	onLimitViolation?(violation: RuntimeSessionLimitViolation): void
}>

const MESSAGE_TOO_BIG = 1009
const TRY_AGAIN_LATER = 1013

/** Adapts one already-open host Elysia socket to Cap'n Web's small DOM WebSocket surface. */
export class RuntimeSessionWebSocket {
	private readonly listeners = new Map<
		CapnwebWebSocketEventName,
		Set<EventListenerOrEventListenerObject>
	>()
	private closedState = false

	readonly webSocket: WebSocket

	constructor(
		private readonly socket: ElysiaWS<any>,
		private readonly options: RuntimeSessionWebSocketOptions,
	) {
		const readyState = () => (this.closedState ? 3 : this.socket.readyState)
		this.webSocket = {
			get readyState() {
				return readyState()
			},
			addEventListener: (type: string, listener: EventListenerOrEventListenerObject | null) =>
				this.addEventListener(type, listener),
			removeEventListener: (type: string, listener: EventListenerOrEventListenerObject | null) =>
				this.removeEventListener(type, listener),
			send: (data) => this.send(data),
			close: (code, reason) => this.close(code, reason),
		} as WebSocket
	}

	receive(message: unknown): void {
		if (this.closedState) return
		if (typeof message !== 'string') {
			this.close(1003, "Cap'n Web requires text messages")
			return
		}
		const actualBytes = utf8Bytes(message)
		if (actualBytes > this.options.maxMessageBytes) {
			this.rejectLimit({
				kind: 'inbound-message-bytes',
				actualBytes,
				limitBytes: this.options.maxMessageBytes,
			})
			return
		}
		this.dispatch('message', { data: message })
	}

	closed(code = 1000, reason = ''): void {
		if (this.closedState) return
		this.closedState = true
		this.dispatch('close', { code, reason })
	}

	errored(error: unknown): void {
		if (this.closedState) return
		this.dispatch('error', { error })
	}

	close(code = 1000, reason = ''): void {
		if (this.closedState) return
		this.socket.raw.close(code, reason)
	}

	private send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		if (this.closedState) throw new Error("Cap'n Web session socket is closed")
		if (typeof data !== 'string') {
			throw new TypeError("Cap'n Web's WebSocket transport only sends text messages")
		}
		const actualBytes = utf8Bytes(data)
		if (actualBytes > this.options.maxMessageBytes) {
			this.rejectLimit({
				kind: 'outbound-message-bytes',
				actualBytes,
				limitBytes: this.options.maxMessageBytes,
			})
			throw new Error("Cap'n Web outbound message exceeds the configured byte ceiling")
		}
		const status = this.socket.send(data)
		if (typeof status === 'number' && status <= 0) {
			this.options.onLimitViolation?.({
				kind: 'outbound-queue',
				actualBytes,
				limitBytes: 0,
			})
			this.close(TRY_AGAIN_LATER, 'Control session backpressure limit exceeded')
			throw new Error("Cap'n Web outbound queue is backpressured")
		}
	}

	private rejectLimit(violation: RuntimeSessionLimitViolation): void {
		this.options.onLimitViolation?.(Object.freeze(violation))
		this.close(MESSAGE_TOO_BIG, `${violation.kind} exceeded`)
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

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength
}

function isSupportedEvent(type: string): type is CapnwebWebSocketEventName {
	return type === 'close' || type === 'error' || type === 'message' || type === 'open'
}

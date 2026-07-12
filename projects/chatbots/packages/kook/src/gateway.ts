import { abortableDelay, ExponentialBackoff } from '@repo/chatbots-hub'
import {
	SIGNAL_EVENT,
	SIGNAL_HELLO,
	SIGNAL_PING,
	SIGNAL_PONG,
	SIGNAL_RECONNECT,
	type KookEvent,
	type KookGatewayFrame,
} from './protocol.ts'

type GatewayLogger = {
	info(message: string, data?: Record<string, unknown>): void
	warn(message: string, data?: Record<string, unknown>): void
}

export type KookGatewayHooks = {
	getUrl(signal: AbortSignal): Promise<string>
	onEvent(event: KookEvent, signal: AbortSignal): Promise<void>
	onOnline(sessionId?: string): void
	onOffline(): void
	onError(error: unknown): void
}

/** KOOK gateway connection, heartbeat and retry state machine. */
export class KookGateway {
	private controller?: AbortController
	private socket?: WebSocket
	private heartbeat?: ReturnType<typeof setInterval>
	private reconnect?: Promise<void>
	private readonly backoff = new ExponentialBackoff({ maxMs: 60_000 })
	private lastSequence = 0
	private awaitingPongAt = 0

	constructor(
		private readonly hooks: KookGatewayHooks,
		private readonly logger: GatewayLogger,
	) {}

	start(ownerSignal?: AbortSignal): void {
		this.stop()
		this.backoff.reset()
		this.controller = new AbortController()
		const signal = ownerSignal
			? AbortSignal.any([ownerSignal, this.controller.signal])
			: this.controller.signal
		void this.connect(signal)
	}

	stop(): void {
		this.controller?.abort()
		this.controller = undefined
		this.reconnect = undefined
		this.stopHeartbeat()
		this.socket?.close(1000, 'plugin stopped')
		this.socket = undefined
	}

	private async connect(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return
		try {
			const url = await this.hooks.getUrl(signal)
			if (!signal.aborted) this.openSocket(url, signal)
		} catch (error) {
			if (signal.aborted) return
			this.hooks.onError(error)
			this.logger.warn('KOOK gateway connection failed', { error })
			this.scheduleReconnect(signal)
		}
	}

	private openSocket(url: string, signal: AbortSignal): void {
		this.socket?.close()
		const socket = new WebSocket(url)
		this.socket = socket
		const abort = () => socket.close(1000, 'plugin stopped')
		signal.addEventListener('abort', abort, { once: true })
		socket.addEventListener('message', (message) => {
			void this.handleFrame(message.data, socket, signal)
		})
		socket.addEventListener('error', () => this.logger.warn('KOOK gateway WebSocket error'))
		socket.addEventListener('close', (event) => {
			signal.removeEventListener('abort', abort)
			this.stopHeartbeat()
			if (this.socket === socket) this.socket = undefined
			if (!signal.aborted) {
				this.hooks.onOffline()
				this.logger.warn('KOOK gateway disconnected', { code: event.code, reason: event.reason })
				this.scheduleReconnect(signal)
			}
		})
	}

	private async handleFrame(raw: unknown, socket: WebSocket, signal: AbortSignal): Promise<void> {
		try {
			const text =
				typeof raw === 'string' ? raw : raw instanceof Blob ? await raw.text() : String(raw)
			const frame = JSON.parse(text) as KookGatewayFrame
			if (frame.s === SIGNAL_HELLO) {
				const hello = frame.d as { code?: number; session_id?: string } | undefined
				if (hello?.code !== 0) {
					this.logger.warn('KOOK gateway rejected session', { code: hello?.code })
					socket.close(4000, 'gateway hello rejected')
					return
				}
				this.backoff.reset()
				this.startHeartbeat(socket)
				this.hooks.onOnline(hello.session_id)
				return
			}
			if (frame.s === SIGNAL_PONG) {
				this.awaitingPongAt = 0
				return
			}
			if (frame.s === SIGNAL_RECONNECT) {
				socket.close(4001, 'gateway requested reconnect')
				return
			}
			if (frame.s !== SIGNAL_EVENT || !frame.d) return
			this.lastSequence = Math.max(this.lastSequence, frame.sn ?? 0)
			await this.hooks.onEvent(frame.d as KookEvent, signal)
		} catch (error) {
			if (!signal.aborted) this.logger.warn('Failed to process KOOK gateway frame', { error })
		}
	}

	private startHeartbeat(socket: WebSocket): void {
		this.stopHeartbeat()
		this.heartbeat = setInterval(() => {
			if (socket.readyState !== WebSocket.OPEN) return
			if (this.awaitingPongAt && Date.now() - this.awaitingPongAt > 10_000) {
				socket.close(4002, 'heartbeat timeout')
				return
			}
			this.awaitingPongAt = Date.now()
			socket.send(JSON.stringify({ s: SIGNAL_PING, sn: this.lastSequence }))
		}, 30_000)
	}

	private stopHeartbeat(): void {
		if (this.heartbeat) clearInterval(this.heartbeat)
		this.heartbeat = undefined
		this.awaitingPongAt = 0
	}

	private scheduleReconnect(signal: AbortSignal): void {
		if (signal.aborted || this.reconnect) return
		const pending = abortableDelay(this.backoff.next(), signal)
			.then(() => {
				if (this.reconnect === pending) this.reconnect = undefined
				return this.connect(signal)
			})
			.catch((): void => {
				if (this.reconnect === pending) this.reconnect = undefined
			})
		this.reconnect = pending
	}
}

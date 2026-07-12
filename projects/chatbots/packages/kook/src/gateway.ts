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

export type KookGatewayPhase = 'idle' | 'connecting' | 'online' | 'backoff' | 'stopped'

export type KookGatewaySnapshot = Readonly<{
	phase: KookGatewayPhase
	sessionId: string | null
	lastSequence: number
	currentBackoffMs: number
	lastError: string | null
	counters: Readonly<{
		connectAttempts: number
		reconnectAttempts: number
		eventsReceived: number
		pingSent: number
		pongReceived: number
		reconnectNotices: number
	}>
	timestamps: Readonly<{
		lastHelloAt: number | null
		lastEventAt: number | null
		lastPingAt: number | null
		lastPongAt: number | null
	}>
}>

export type KookGatewayHooks = {
	getUrl(signal: AbortSignal): Promise<string>
	onEvent(event: KookEvent, signal: AbortSignal): Promise<void>
	onOnline(sessionId?: string): void
	onOffline(): void
	onError(error: unknown): void
	onSnapshot?(snapshot: KookGatewaySnapshot): void
}

export type KookGatewayOptions = {
	createSocket?: (url: string) => WebSocket
	heartbeatIntervalMs?: number
	pongTimeoutMs?: number
	now?: () => number
}

/** KOOK gateway connection, heartbeat and retry state machine. */
export class KookGateway {
	private controller?: AbortController
	private socket?: WebSocket
	private heartbeat?: ReturnType<typeof setInterval>
	private reconnect?: Promise<void>
	private readonly backoff = new ExponentialBackoff({ maxMs: 60_000 })
	private readonly createSocket: (url: string) => WebSocket
	private readonly heartbeatIntervalMs: number
	private readonly pongTimeoutMs: number
	private readonly now: () => number
	private awaitingPongAt = 0
	private snapshotValue = createKookGatewaySnapshot()

	constructor(
		private readonly hooks: KookGatewayHooks,
		private readonly logger: GatewayLogger,
		options: KookGatewayOptions = {},
	) {
		this.createSocket = options.createSocket ?? ((url) => new WebSocket(url))
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000
		this.pongTimeoutMs = options.pongTimeoutMs ?? 10_000
		this.now = options.now ?? Date.now
	}

	get snapshot(): KookGatewaySnapshot {
		return this.snapshotValue
	}

	start(ownerSignal?: AbortSignal): void {
		this.stop(false)
		this.backoff.reset()
		this.snapshotValue = createKookGatewaySnapshot({ phase: 'connecting' })
		this.hooks.onSnapshot?.(this.snapshotValue)
		this.controller = new AbortController()
		const signal = ownerSignal
			? AbortSignal.any([ownerSignal, this.controller.signal])
			: this.controller.signal
		void this.connect(signal)
	}

	stop(publish = true): void {
		this.controller?.abort()
		this.controller = undefined
		this.reconnect = undefined
		this.stopHeartbeat()
		this.socket?.close(1000, 'plugin stopped')
		this.socket = undefined
		if (publish) this.updateSnapshot({ phase: 'stopped', currentBackoffMs: 0 })
	}

	private async connect(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return
		this.updateSnapshot({
			phase: 'connecting',
			currentBackoffMs: 0,
			counters: { connectAttempts: this.snapshot.counters.connectAttempts + 1 },
		})
		try {
			const url = await this.hooks.getUrl(signal)
			if (!signal.aborted) this.openSocket(url, signal)
		} catch (error) {
			if (signal.aborted) return
			this.recordError(error)
			this.logger.warn('KOOK gateway connection failed', { error })
			this.scheduleReconnect(signal)
		}
	}

	private openSocket(url: string, signal: AbortSignal): void {
		this.socket?.close()
		const socket = this.createSocket(url)
		this.socket = socket
		const abort = () => socket.close(1000, 'plugin stopped')
		signal.addEventListener('abort', abort, { once: true })
		socket.addEventListener('message', (message) => {
			void this.handleFrame(message.data, socket, signal)
		})
		socket.addEventListener('error', () => {
			this.logger.warn('KOOK gateway WebSocket error')
		})
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
					const error = new Error(`KOOK gateway rejected session: ${hello?.code ?? 'unknown'}`)
					this.recordError(error)
					socket.close(4000, 'gateway hello rejected')
					return
				}
				this.backoff.reset()
				this.startHeartbeat(socket)
				this.updateSnapshot({
					phase: 'online',
					sessionId: hello.session_id ?? null,
					currentBackoffMs: 0,
					lastError: null,
					timestamps: { lastHelloAt: this.now() },
				})
				this.hooks.onOnline(hello.session_id)
				return
			}
			if (frame.s === SIGNAL_PONG) {
				this.awaitingPongAt = 0
				this.updateSnapshot({
					counters: { pongReceived: this.snapshot.counters.pongReceived + 1 },
					timestamps: { lastPongAt: this.now() },
				})
				return
			}
			if (frame.s === SIGNAL_RECONNECT) {
				this.updateSnapshot({
					counters: { reconnectNotices: this.snapshot.counters.reconnectNotices + 1 },
				})
				socket.close(4001, 'gateway requested reconnect')
				return
			}
			if (frame.s !== SIGNAL_EVENT || !frame.d) return
			this.updateSnapshot({
				lastSequence: Math.max(this.snapshot.lastSequence, frame.sn ?? 0),
				counters: { eventsReceived: this.snapshot.counters.eventsReceived + 1 },
				timestamps: { lastEventAt: this.now() },
			})
			await this.hooks.onEvent(frame.d as KookEvent, signal)
		} catch (error) {
			if (!signal.aborted) {
				this.recordError(error)
				this.logger.warn('Failed to process KOOK gateway frame', { error })
			}
		}
	}

	private startHeartbeat(socket: WebSocket): void {
		this.stopHeartbeat()
		this.heartbeat = setInterval(() => {
			if (socket.readyState !== 1) return
			if (this.awaitingPongAt && this.now() - this.awaitingPongAt > this.pongTimeoutMs) {
				socket.close(4002, 'heartbeat timeout')
				return
			}
			this.awaitingPongAt = this.now()
			socket.send(JSON.stringify({ s: SIGNAL_PING, sn: this.snapshot.lastSequence }))
			this.updateSnapshot({
				counters: { pingSent: this.snapshot.counters.pingSent + 1 },
				timestamps: { lastPingAt: this.awaitingPongAt },
			})
		}, this.heartbeatIntervalMs)
	}

	private stopHeartbeat(): void {
		if (this.heartbeat) clearInterval(this.heartbeat)
		this.heartbeat = undefined
		this.awaitingPongAt = 0
	}

	private scheduleReconnect(signal: AbortSignal): void {
		if (signal.aborted || this.reconnect) return
		const delay = this.backoff.next()
		this.updateSnapshot({
			phase: 'backoff',
			currentBackoffMs: delay,
			counters: { reconnectAttempts: this.snapshot.counters.reconnectAttempts + 1 },
		})
		const pending = abortableDelay(delay, signal)
			.then(() => {
				if (this.reconnect === pending) this.reconnect = undefined
				return this.connect(signal)
			})
			.catch((): void => {
				if (this.reconnect === pending) this.reconnect = undefined
			})
		this.reconnect = pending
	}

	private recordError(error: unknown): void {
		this.updateSnapshot({ lastError: error instanceof Error ? error.message : String(error) })
		this.hooks.onError(error)
	}

	private updateSnapshot(
		patch: Partial<Omit<KookGatewaySnapshot, 'counters' | 'timestamps'>> & {
			counters?: Partial<KookGatewaySnapshot['counters']>
			timestamps?: Partial<KookGatewaySnapshot['timestamps']>
		},
	): void {
		this.snapshotValue = createKookGatewaySnapshot({
			...this.snapshotValue,
			...patch,
			counters: { ...this.snapshotValue.counters, ...patch.counters },
			timestamps: { ...this.snapshotValue.timestamps, ...patch.timestamps },
		})
		this.hooks.onSnapshot?.(this.snapshotValue)
	}
}

export function createKookGatewaySnapshot(
	patch: Partial<KookGatewaySnapshot> = {},
): KookGatewaySnapshot {
	return Object.freeze({
		phase: patch.phase ?? 'idle',
		sessionId: patch.sessionId ?? null,
		lastSequence: patch.lastSequence ?? 0,
		currentBackoffMs: patch.currentBackoffMs ?? 0,
		lastError: patch.lastError ?? null,
		counters: Object.freeze({
			connectAttempts: patch.counters?.connectAttempts ?? 0,
			reconnectAttempts: patch.counters?.reconnectAttempts ?? 0,
			eventsReceived: patch.counters?.eventsReceived ?? 0,
			pingSent: patch.counters?.pingSent ?? 0,
			pongReceived: patch.counters?.pongReceived ?? 0,
			reconnectNotices: patch.counters?.reconnectNotices ?? 0,
		}),
		timestamps: Object.freeze({
			lastHelloAt: patch.timestamps?.lastHelloAt ?? null,
			lastEventAt: patch.timestamps?.lastEventAt ?? null,
			lastPingAt: patch.timestamps?.lastPingAt ?? null,
			lastPongAt: patch.timestamps?.lastPongAt ?? null,
		}),
	})
}

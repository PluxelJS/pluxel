import { abortableDelay, ExponentialBackoff } from '@repo/chatbots-adapter-kit/backoff'
import {
	SIGNAL_EVENT,
	SIGNAL_HELLO,
	SIGNAL_PING,
	SIGNAL_PONG,
	SIGNAL_RECONNECT,
	SIGNAL_RESUME,
	SIGNAL_RESUME_ACK,
	type KookEvent,
	type KookGatewayFrame,
} from './protocol.ts'

type GatewayLogger = {
	info(message: string, data?: Record<string, unknown>): void
	warn(message: string, data?: Record<string, unknown>): void
}

export type KookGatewayPhase = 'idle' | 'connecting' | 'resuming' | 'online' | 'backoff' | 'stopped'

export type KookGatewayResumeRequest = Readonly<{
	resume: boolean
	sessionId?: string
	lastSequence: number
}>

export type KookGatewaySnapshot = Readonly<{
	phase: KookGatewayPhase
	sessionId: string | null
	lastSequence: number
	bufferedEvents: number
	currentBackoffMs: number
	lastError: string | null
	counters: Readonly<{
		connectAttempts: number
		reconnectAttempts: number
		resumeAttempts: number
		eventsReceived: number
		duplicateEvents: number
		outOfOrderEvents: number
		bufferOverflows: number
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
	getUrl(request: KookGatewayResumeRequest, signal: AbortSignal): Promise<string>
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
	helloTimeoutMs?: number
	resumeAckTimeoutMs?: number
	maxResumeAttempts?: number
	bufferMax?: number
	now?: () => number
}

/** KOOK gateway connection, heartbeat and retry state machine. */
export class KookGateway {
	private controller?: AbortController
	private socket?: WebSocket
	private heartbeat?: ReturnType<typeof setInterval>
	private helloTimer?: ReturnType<typeof setTimeout>
	private resumeAckTimer?: ReturnType<typeof setTimeout>
	private reconnect?: Promise<void>
	private frameTail: Promise<void> = Promise.resolve()
	private readonly buffer = new Map<number, KookGatewayFrame>()
	private readonly backoff = new ExponentialBackoff({ maxMs: 60_000 })
	private readonly createSocket: (url: string) => WebSocket
	private readonly heartbeatIntervalMs: number
	private readonly pongTimeoutMs: number
	private readonly helloTimeoutMs: number
	private readonly resumeAckTimeoutMs: number
	private readonly maxResumeAttempts: number
	private readonly bufferMax: number
	private readonly now: () => number
	private awaitingPongAt = 0
	private resumeAttemptsSinceOnline = 0
	private snapshotValue = createKookGatewaySnapshot()

	constructor(
		private readonly hooks: KookGatewayHooks,
		private readonly logger: GatewayLogger,
		options: KookGatewayOptions = {},
	) {
		this.createSocket = options.createSocket ?? ((url) => new WebSocket(url))
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000
		this.pongTimeoutMs = options.pongTimeoutMs ?? 10_000
		this.helloTimeoutMs = options.helloTimeoutMs ?? 6_000
		this.resumeAckTimeoutMs = options.resumeAckTimeoutMs ?? 6_000
		this.maxResumeAttempts = options.maxResumeAttempts ?? 2
		this.bufferMax = options.bufferMax ?? 1_024
		this.now = options.now ?? Date.now
	}

	get snapshot(): KookGatewaySnapshot {
		return this.snapshotValue
	}

	start(ownerSignal?: AbortSignal): void {
		this.stop(false)
		this.backoff.reset()
		this.buffer.clear()
		this.frameTail = Promise.resolve()
		this.resumeAttemptsSinceOnline = 0
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
		this.stopHelloTimer()
		this.stopResumeAckTimer()
		this.socket?.close(1000, 'plugin stopped')
		this.socket = undefined
		if (publish) this.updateSnapshot({ phase: 'stopped', currentBackoffMs: 0 })
	}

	private async connect(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return
		if (this.snapshot.sessionId && this.resumeAttemptsSinceOnline >= this.maxResumeAttempts)
			this.dropResumeState()
		const resume = this.snapshot.sessionId !== null
		if (resume) this.resumeAttemptsSinceOnline += 1
		this.updateSnapshot({
			phase: resume ? 'resuming' : 'connecting',
			currentBackoffMs: 0,
			counters: {
				connectAttempts: this.snapshot.counters.connectAttempts + 1,
				...(resume ? { resumeAttempts: this.snapshot.counters.resumeAttempts + 1 } : {}),
			},
		})
		try {
			const url = await this.hooks.getUrl(
				{
					resume,
					sessionId: this.snapshot.sessionId ?? undefined,
					lastSequence: this.snapshot.lastSequence,
				},
				signal,
			)
			if (!signal.aborted) this.openSocket(url, signal, resume)
		} catch (error) {
			if (signal.aborted) return
			this.recordError(error)
			this.logger.warn('KOOK gateway connection failed', { error })
			this.scheduleReconnect(signal)
		}
	}

	private goOnline(socket: WebSocket, sessionId?: string): void {
		this.backoff.reset()
		this.resumeAttemptsSinceOnline = 0
		this.startHeartbeat(socket)
		this.updateSnapshot({
			phase: 'online',
			sessionId: sessionId ?? null,
			currentBackoffMs: 0,
			lastError: null,
		})
		this.hooks.onOnline(sessionId)
	}

	private async handleEventOrdered(
		frame: KookGatewayFrame,
		signal: AbortSignal,
		socket: WebSocket,
	): Promise<void> {
		const sequence = frame.sn
		if (sequence === undefined) throw new Error('KOOK gateway event is missing sn')
		if (sequence <= this.snapshot.lastSequence) {
			this.updateSnapshot({
				counters: { duplicateEvents: this.snapshot.counters.duplicateEvents + 1 },
			})
			return
		}
		const expected = this.snapshot.lastSequence + 1
		if (sequence !== expected) {
			if (this.buffer.has(sequence)) {
				this.updateSnapshot({
					counters: { duplicateEvents: this.snapshot.counters.duplicateEvents + 1 },
				})
				return
			}
			if (this.buffer.size >= this.bufferMax) {
				this.updateSnapshot({
					counters: { bufferOverflows: this.snapshot.counters.bufferOverflows + 1 },
				})
				socket.close(4003, 'event sequence buffer overflow')
				return
			}
			this.buffer.set(sequence, frame)
			this.updateSnapshot({
				bufferedEvents: this.buffer.size,
				counters: { outOfOrderEvents: this.snapshot.counters.outOfOrderEvents + 1 },
			})
			return
		}

		if (!(await this.consumeEvent(frame.d as KookEvent, sequence, signal))) return
		for (;;) {
			const next = this.snapshot.lastSequence + 1
			const buffered = this.buffer.get(next)
			if (!buffered) break
			this.buffer.delete(next)
			if (!(await this.consumeEvent(buffered.d as KookEvent, next, signal))) return
		}
		if (this.snapshot.bufferedEvents !== this.buffer.size)
			this.updateSnapshot({ bufferedEvents: this.buffer.size })
	}

	private async consumeEvent(
		event: KookEvent,
		sequence: number,
		signal: AbortSignal,
	): Promise<boolean> {
		await this.hooks.onEvent(event, signal)
		if (signal.aborted) return false
		this.updateSnapshot({
			lastSequence: sequence,
			counters: { eventsReceived: this.snapshot.counters.eventsReceived + 1 },
			timestamps: { lastEventAt: this.now() },
		})
		return true
	}

	private openSocket(url: string, signal: AbortSignal, resume: boolean): void {
		this.socket?.close()
		const socket = this.createSocket(url)
		this.socket = socket
		this.helloTimer = setTimeout(() => {
			if (this.socket !== socket) return
			if (resume) this.dropResumeState()
			const error = new Error('KOOK gateway HELLO timeout')
			this.recordError(error)
			socket.close(4006, 'gateway HELLO timeout')
		}, this.helloTimeoutMs)
		const abort = () => socket.close(1000, 'plugin stopped')
		signal.addEventListener('abort', abort, { once: true })
		socket.addEventListener('message', (message) => {
			this.frameTail = this.frameTail.then(async (): Promise<void> => {
				if (signal.aborted || this.socket !== socket) return undefined
				await this.handleFrame(message.data, socket, signal, resume)
				return undefined
			})
		})
		socket.addEventListener('error', () => {
			this.logger.warn('KOOK gateway WebSocket error')
		})
		socket.addEventListener('close', (event) => {
			signal.removeEventListener('abort', abort)
			if (this.socket !== socket) return
			this.stopHeartbeat()
			this.stopHelloTimer()
			this.stopResumeAckTimer()
			this.socket = undefined
			if (!signal.aborted) {
				this.hooks.onOffline()
				this.logger.warn('KOOK gateway disconnected', { code: event.code, reason: event.reason })
				this.scheduleReconnect(signal)
			}
		})
	}

	private async handleFrame(
		raw: unknown,
		socket: WebSocket,
		signal: AbortSignal,
		resume: boolean,
	): Promise<void> {
		try {
			const text =
				typeof raw === 'string' ? raw : raw instanceof Blob ? await raw.text() : String(raw)
			const frame = JSON.parse(text) as KookGatewayFrame
			if (frame.s === SIGNAL_HELLO) {
				this.stopHelloTimer()
				const hello = frame.d as { code?: number; session_id?: string } | undefined
				if (hello?.code !== 0) {
					const error = new Error(`KOOK gateway rejected session: ${hello?.code ?? 'unknown'}`)
					if (resume) this.dropResumeState()
					this.recordError(error)
					socket.close(4000, 'gateway hello rejected')
					return
				}
				this.updateSnapshot({ timestamps: { lastHelloAt: this.now() } })
				if (resume) {
					this.updateSnapshot({ phase: 'resuming' })
					socket.send(JSON.stringify({ s: SIGNAL_RESUME, sn: this.snapshot.lastSequence }))
					this.resumeAckTimer = setTimeout(() => {
						this.dropResumeState()
						const error = new Error('KOOK gateway resume ACK timeout')
						this.recordError(error)
						socket.close(4005, 'resume ACK timeout')
					}, this.resumeAckTimeoutMs)
					return
				}
				this.goOnline(socket, hello.session_id)
				return
			}
			if (frame.s === SIGNAL_RESUME_ACK && resume) {
				this.stopResumeAckTimer()
				const ack = frame.d as { session_id?: string } | undefined
				this.goOnline(socket, ack?.session_id ?? this.snapshot.sessionId ?? undefined)
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
				this.dropResumeState()
				socket.close(4001, 'gateway requested reconnect')
				return
			}
			if (frame.s !== SIGNAL_EVENT || !frame.d) return
			await this.handleEventOrdered(frame, signal, socket)
		} catch (error) {
			if (!signal.aborted) {
				this.recordError(error)
				this.logger.warn('Failed to process KOOK gateway frame', { error })
				socket.close(4004, 'gateway frame processing failed')
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

	private stopResumeAckTimer(): void {
		if (this.resumeAckTimer) clearTimeout(this.resumeAckTimer)
		this.resumeAckTimer = undefined
	}

	private stopHelloTimer(): void {
		if (this.helloTimer) clearTimeout(this.helloTimer)
		this.helloTimer = undefined
	}

	private dropResumeState(): void {
		this.stopResumeAckTimer()
		this.buffer.clear()
		this.updateSnapshot({
			sessionId: null,
			lastSequence: 0,
			bufferedEvents: 0,
		})
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
			.then(async () => {
				if (this.reconnect === pending) this.reconnect = undefined
				await this.frameTail
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
		bufferedEvents: patch.bufferedEvents ?? 0,
		currentBackoffMs: patch.currentBackoffMs ?? 0,
		lastError: patch.lastError ?? null,
		counters: Object.freeze({
			connectAttempts: patch.counters?.connectAttempts ?? 0,
			reconnectAttempts: patch.counters?.reconnectAttempts ?? 0,
			resumeAttempts: patch.counters?.resumeAttempts ?? 0,
			eventsReceived: patch.counters?.eventsReceived ?? 0,
			duplicateEvents: patch.counters?.duplicateEvents ?? 0,
			outOfOrderEvents: patch.counters?.outOfOrderEvents ?? 0,
			bufferOverflows: patch.counters?.bufferOverflows ?? 0,
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

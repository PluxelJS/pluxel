import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	KookGateway,
	type KookGatewayResumeRequest,
	type KookGatewaySnapshot,
} from '../src/gateway.ts'
import type { KookEvent } from '../src/protocol.ts'

class FakeWebSocket extends EventTarget {
	readyState = 1
	readonly sent: string[] = []
	readonly closes: Array<{ code?: number; reason?: string }> = []

	send(data: string): void {
		this.sent.push(data)
	}

	close(code?: number, reason?: string): void {
		if (this.readyState === 3) return
		this.readyState = 3
		this.closes.push({ code, reason })
		const event = new Event('close')
		Object.defineProperties(event, {
			code: { value: code ?? 1000 },
			reason: { value: reason ?? '' },
		})
		this.dispatchEvent(event)
	}

	frame(value: unknown): void {
		const event = new Event('message')
		Object.defineProperty(event, 'data', { value: JSON.stringify(value) })
		this.dispatchEvent(event)
	}
}

afterEach(() => vi.useRealTimers())

describe('KookGateway diagnostics', () => {
	it('publishes immutable handshake, event, heartbeat, backoff and stop snapshots', async () => {
		vi.useFakeTimers()
		let now = 1_000
		const sockets: FakeWebSocket[] = []
		const snapshots: KookGatewaySnapshot[] = []
		const events: KookEvent[] = []
		const gateway = new KookGateway(
			{
				async getUrl() {
					return 'wss://gateway.test'
				},
				async onEvent(event) {
					events.push(event)
				},
				onOnline() {},
				onOffline() {},
				onError() {},
				onSnapshot(snapshot) {
					snapshots.push(snapshot)
				},
			},
			{ info() {}, warn() {} },
			{
				createSocket: () => {
					const socket = new FakeWebSocket()
					sockets.push(socket)
					return socket as unknown as WebSocket
				},
				heartbeatIntervalMs: 100,
				pongTimeoutMs: 50,
				now: () => now,
			},
		)

		gateway.start()
		await flushMicrotasks()
		const socket = sockets[0]!
		expect(gateway.snapshot).toMatchObject({
			phase: 'connecting',
			counters: { connectAttempts: 1 },
		})

		now = 1_100
		socket.frame({ s: 1, d: { code: 0, session_id: 'session-1' } })
		await flushMicrotasks()
		expect(gateway.snapshot).toMatchObject({
			phase: 'online',
			sessionId: 'session-1',
			timestamps: { lastHelloAt: 1_100 },
		})
		expect(Object.isFrozen(gateway.snapshot)).toBe(true)
		expect(Object.isFrozen(gateway.snapshot.counters)).toBe(true)

		now = 1_200
		socket.frame({ s: 0, sn: 1, d: kookEvent() })
		await flushMicrotasks()
		expect(events).toHaveLength(1)
		expect(gateway.snapshot).toMatchObject({
			lastSequence: 1,
			counters: { eventsReceived: 1 },
			timestamps: { lastEventAt: 1_200 },
		})

		now = 1_300
		await vi.advanceTimersByTimeAsync(100)
		expect(JSON.parse(socket.sent[0]!)).toEqual({ s: 2, sn: 1 })
		expect(gateway.snapshot.counters.pingSent).toBe(1)
		socket.frame({ s: 3 })
		await flushMicrotasks()
		expect(gateway.snapshot.counters.pongReceived).toBe(1)

		socket.close(1006, 'network lost')
		expect(gateway.snapshot).toMatchObject({
			phase: 'backoff',
			counters: { reconnectAttempts: 1 },
		})
		expect(gateway.snapshot.currentBackoffMs).toBeGreaterThan(0)

		gateway.stop()
		expect(gateway.snapshot.phase).toBe('stopped')
		const socketCount = sockets.length
		await vi.runAllTimersAsync()
		expect(sockets).toHaveLength(socketCount)
		expect(snapshots.at(-1)?.phase).toBe('stopped')
	})

	it('serializes, buffers and deduplicates ordered events', async () => {
		const sockets: FakeWebSocket[] = []
		const events: KookEvent[] = []
		const gateway = createGateway(sockets, {
			onEvent(event) {
				events.push(event)
			},
		})

		gateway.start()
		await flushMicrotasks()
		const socket = sockets[0]!
		socket.frame({ s: 1, d: { code: 0, session_id: 'session-1' } })
		socket.frame({ s: 0, sn: 2, d: kookEvent('message-2') })
		socket.frame({ s: 0, sn: 1, d: kookEvent('message-1') })
		await flushMicrotasks()
		socket.frame({ s: 0, sn: 2, d: kookEvent('message-2-duplicate') })
		await flushMicrotasks()

		expect(events.map((event) => event.msg_id)).toEqual(['message-1', 'message-2'])
		expect(gateway.snapshot).toMatchObject({
			lastSequence: 2,
			bufferedEvents: 0,
			counters: {
				eventsReceived: 2,
				outOfOrderEvents: 1,
				duplicateEvents: 1,
			},
		})
		gateway.stop()
	})

	it('resumes a session from its last completed sequence', async () => {
		vi.useFakeTimers()
		const sockets: FakeWebSocket[] = []
		const requests: KookGatewayResumeRequest[] = []
		const gateway = createGateway(sockets, {
			getUrl(request) {
				requests.push(request)
			},
		})

		gateway.start()
		await flushMicrotasks()
		sockets[0]!.frame({ s: 1, d: { code: 0, session_id: 'session-1' } })
		sockets[0]!.frame({ s: 0, sn: 1, d: kookEvent() })
		await flushMicrotasks()
		sockets[0]!.close(1006, 'network lost')
		await vi.advanceTimersByTimeAsync(gateway.snapshot.currentBackoffMs)
		await flushMicrotasks()

		expect(requests[1]).toEqual({
			resume: true,
			sessionId: 'session-1',
			lastSequence: 1,
		})
		const resumed = sockets[1]!
		resumed.frame({ s: 1, d: { code: 0, session_id: 'hello-session' } })
		await flushMicrotasks()
		expect(resumed.sent.map((value) => JSON.parse(value))).toContainEqual({ s: 4, sn: 1 })
		resumed.frame({ s: 6, d: { session_id: 'session-2' } })
		await flushMicrotasks()
		expect(gateway.snapshot).toMatchObject({
			phase: 'online',
			sessionId: 'session-2',
			lastSequence: 1,
			counters: { resumeAttempts: 1 },
		})
		gateway.stop()
	})

	it('waits for the event tail before requesting a resume URL', async () => {
		vi.useFakeTimers()
		const sockets: FakeWebSocket[] = []
		const requests: KookGatewayResumeRequest[] = []
		let completeEvent: (() => void) | undefined
		const eventPending = new Promise<void>((resolve) => {
			completeEvent = resolve
		})
		const gateway = createGateway(sockets, {
			getUrl(request) {
				requests.push(request)
			},
			onEvent() {
				return eventPending
			},
		})

		gateway.start()
		await flushMicrotasks()
		sockets[0]!.frame({ s: 1, d: { code: 0, session_id: 'session-1' } })
		sockets[0]!.frame({ s: 0, sn: 1, d: kookEvent() })
		await flushMicrotasks()
		sockets[0]!.close(1006, 'network lost')
		await vi.advanceTimersByTimeAsync(gateway.snapshot.currentBackoffMs)
		await flushMicrotasks()
		expect(requests).toHaveLength(1)
		expect(gateway.snapshot.lastSequence).toBe(0)

		completeEvent?.()
		await flushMicrotasks()
		expect(requests[1]).toEqual({
			resume: true,
			sessionId: 'session-1',
			lastSequence: 1,
		})
		gateway.stop()
	})

	it('does not commit a pending event after its owner stops', async () => {
		const sockets: FakeWebSocket[] = []
		let completeEvent: (() => void) | undefined
		const eventPending = new Promise<void>((resolve) => {
			completeEvent = resolve
		})
		const gateway = createGateway(sockets, {
			onEvent() {
				return eventPending
			},
		})

		gateway.start()
		await flushMicrotasks()
		sockets[0]!.frame({ s: 1, d: { code: 0, session_id: 'session-1' } })
		sockets[0]!.frame({ s: 0, sn: 1, d: kookEvent() })
		await flushMicrotasks()
		gateway.stop()
		completeEvent?.()
		await flushMicrotasks()

		expect(gateway.snapshot).toMatchObject({ phase: 'stopped', lastSequence: 0 })
	})

	it('closes the socket when the out-of-order buffer reaches its bound', async () => {
		const sockets: FakeWebSocket[] = []
		const gateway = createGateway(sockets, {}, { bufferMax: 1 })

		gateway.start()
		await flushMicrotasks()
		const socket = sockets[0]!
		socket.frame({ s: 1, d: { code: 0, session_id: 'session-1' } })
		socket.frame({ s: 0, sn: 3, d: kookEvent('message-3') })
		socket.frame({ s: 0, sn: 4, d: kookEvent('message-4') })
		await flushMicrotasks()

		expect(socket.closes).toContainEqual({
			code: 4003,
			reason: 'event sequence buffer overflow',
		})
		expect(gateway.snapshot).toMatchObject({
			bufferedEvents: 1,
			counters: { bufferOverflows: 1 },
		})
		gateway.stop()
	})

	it('falls back to a fresh session when resume acknowledgement times out', async () => {
		vi.useFakeTimers()
		const sockets: FakeWebSocket[] = []
		const requests: KookGatewayResumeRequest[] = []
		const gateway = createGateway(
			sockets,
			{
				getUrl(request) {
					requests.push(request)
				},
			},
			{ resumeAckTimeoutMs: 50 },
		)

		gateway.start()
		await flushMicrotasks()
		sockets[0]!.frame({ s: 1, d: { code: 0, session_id: 'session-1' } })
		sockets[0]!.frame({ s: 0, sn: 1, d: kookEvent() })
		await flushMicrotasks()
		sockets[0]!.close(1006, 'network lost')
		await vi.advanceTimersByTimeAsync(gateway.snapshot.currentBackoffMs)
		await flushMicrotasks()
		const resumed = sockets[1]!
		resumed.frame({ s: 1, d: { code: 0, session_id: 'hello-session' } })
		await flushMicrotasks()
		await vi.advanceTimersByTimeAsync(50)
		await flushMicrotasks()

		expect(resumed.closes).toContainEqual({ code: 4005, reason: 'resume ACK timeout' })
		expect(gateway.snapshot).toMatchObject({
			sessionId: null,
			lastSequence: 0,
			bufferedEvents: 0,
		})
		await vi.advanceTimersByTimeAsync(gateway.snapshot.currentBackoffMs)
		await flushMicrotasks()
		expect(requests.at(-1)).toEqual({ resume: false, lastSequence: 0 })
		gateway.stop()
	})

	it('bounds the time spent waiting for the initial HELLO', async () => {
		vi.useFakeTimers()
		const sockets: FakeWebSocket[] = []
		const gateway = createGateway(sockets, {}, { helloTimeoutMs: 50 })

		gateway.start()
		await flushMicrotasks()
		await vi.advanceTimersByTimeAsync(50)
		await flushMicrotasks()

		expect(sockets[0]!.closes).toContainEqual({
			code: 4006,
			reason: 'gateway HELLO timeout',
		})
		expect(gateway.snapshot).toMatchObject({
			phase: 'backoff',
			lastError: 'KOOK gateway HELLO timeout',
		})
		gateway.stop()
	})
})

function createGateway(
	sockets: FakeWebSocket[],
	hooks: {
		getUrl?(request: KookGatewayResumeRequest): void
		onEvent?(event: KookEvent): void | Promise<void>
	},
	options: { bufferMax?: number; helloTimeoutMs?: number; resumeAckTimeoutMs?: number } = {},
): KookGateway {
	return new KookGateway(
		{
			async getUrl(request) {
				hooks.getUrl?.(request)
				return 'wss://gateway.test'
			},
			async onEvent(event) {
				await hooks.onEvent?.(event)
			},
			onOnline() {},
			onOffline() {},
			onError() {},
		},
		{ info() {}, warn() {} },
		{
			...options,
			createSocket: () => {
				const socket = new FakeWebSocket()
				sockets.push(socket)
				return socket as unknown as WebSocket
			},
		},
	)
}

function kookEvent(messageId = 'message-1'): KookEvent {
	return {
		type: 1,
		target_id: 'channel-1',
		author_id: 'user-1',
		content: 'hello',
		msg_id: messageId,
		msg_timestamp: 1,
		channel_type: 'GROUP',
	}
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

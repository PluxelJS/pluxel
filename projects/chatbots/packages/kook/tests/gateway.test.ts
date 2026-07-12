import { afterEach, describe, expect, it, vi } from 'vitest'
import { KookGateway, type KookEvent, type KookGatewaySnapshot } from '../src/index.ts'

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
		socket.frame({ s: 0, sn: 7, d: kookEvent() })
		await flushMicrotasks()
		expect(events).toHaveLength(1)
		expect(gateway.snapshot).toMatchObject({
			lastSequence: 7,
			counters: { eventsReceived: 1 },
			timestamps: { lastEventAt: 1_200 },
		})

		now = 1_300
		await vi.advanceTimersByTimeAsync(100)
		expect(JSON.parse(socket.sent[0]!)).toEqual({ s: 2, sn: 7 })
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
})

function kookEvent(): KookEvent {
	return {
		type: 1,
		target_id: 'channel-1',
		author_id: 'user-1',
		content: 'hello',
		msg_id: 'message-1',
		msg_timestamp: 1,
		channel_type: 'GROUP',
	}
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}

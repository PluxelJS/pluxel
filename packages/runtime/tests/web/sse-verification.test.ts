// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_VERIFICATION_BASE } from '../../src/web/paths'
import { sse } from '../../src/web/sse'

class FakeEventSource {
	static latest: FakeEventSource | null = null

	onopen: ((this: EventSource, ev: Event) => any) | null = null
	onerror: ((this: EventSource, ev: Event) => any) | null = null
	onmessage: ((this: EventSource, ev: MessageEvent<any>) => any) | null = null
	closed = false

	constructor(
		public url: string,
		public options?: EventSourceInit,
	) {
		FakeEventSource.latest = this
	}

	close() {
		this.closed = true
	}
}

async function waitUntil(assertion: () => void, timeoutMs = 1000) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		try {
			assertion()
			return
		} catch (error) {
			if (Date.now() >= deadline) throw error
			await new Promise((resolve) => setTimeout(resolve, 0))
		}
	}
}

describe('runtime/web SSE verification probe', () => {
	afterEach(() => {
		FakeEventSource.latest = null
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('does not treat an allowed security snapshot as blocked', async () => {
		const onBlocked = vi.fn()
		const readState = vi.fn(async () => ({ allow: true as const }))
		vi.stubGlobal('EventSource', FakeEventSource)

		const client = sse({
			url: 'http://local/sse',
			verification: {
				readState,
				onBlocked,
			},
		})
		const source = FakeEventSource.latest
		expect(source).toBeTruthy()

		source!.onerror?.call(source as unknown as EventSource, new Event('error'))
		await waitUntil(() => expect(readState).toHaveBeenCalledTimes(1))

		expect(onBlocked).not.toHaveBeenCalled()
		expect(source!.closed).toBe(false)

		client.close()
	})

	it('closes SSE and redirects to /security when public OIDC is missing', async () => {
		const onBlocked = vi.fn()
		const readState = vi.fn(async () => ({ allow: false as const, reason: 'missing_oidc' as const }))
		vi.stubGlobal('EventSource', FakeEventSource)

		const client = sse({
			url: 'http://local/sse',
			verification: {
				readState,
				onBlocked,
			},
		})
		const source = FakeEventSource.latest
		expect(source).toBeTruthy()

		source!.onerror?.call(source as unknown as EventSource, new Event('error'))
		await waitUntil(() => expect(onBlocked).toHaveBeenCalledTimes(1))

		expect(onBlocked).toHaveBeenCalledWith(
			expect.objectContaining({
				status: 401,
				redirectPath: '/security',
			}),
		)
		expect(source!.closed).toBe(true)

		client.close()
	})

	it('redirects blocked SSE clients to the verification page when external auth is required', async () => {
		const onBlocked = vi.fn()
		const readState = vi.fn(async () =>
			({ allow: false as const, reason: 'unauthenticated' as const }),
		)
		vi.stubGlobal('EventSource', FakeEventSource)

		const client = sse({
			url: 'http://local/sse',
			verification: {
				readState,
				onBlocked,
			},
		})
		const source = FakeEventSource.latest
		expect(source).toBeTruthy()

		source!.onerror?.call(source as unknown as EventSource, new Event('error'))
		await waitUntil(() => expect(onBlocked).toHaveBeenCalledTimes(1))

		expect(onBlocked).toHaveBeenCalledWith(
			expect.objectContaining({
				status: 401,
				redirectPath: RUNTIME_VERIFICATION_BASE,
			}),
		)
		expect(source!.closed).toBe(true)

		client.close()
	})
})

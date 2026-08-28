// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_ADMIN_ACCESS_BASE } from '../../src/web/paths'
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

describe('runtime/web SSE adminAccess probe', () => {
	afterEach(() => {
		FakeEventSource.latest = null
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('does not treat an allowed security snapshot as blocked', async () => {
		const onBlocked = vi.fn()
		const readState = vi.fn(async () => ({ state: 'allowed' as const }))
		vi.stubGlobal('EventSource', FakeEventSource)

		const client = sse({
			url: 'http://local/sse',
			adminAccess: {
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

	it('closes SSE and redirects to local setup when no provider is active', async () => {
		const onBlocked = vi.fn()
		const readState = vi.fn(async () => ({
			state: 'local_setup_required' as const,
		}))
		vi.stubGlobal('EventSource', FakeEventSource)

		const client = sse({
			url: 'http://local/sse',
			adminAccess: {
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
				redirectPath: RUNTIME_ADMIN_ACCESS_BASE,
				status: 403,
			}),
		)
		expect(source!.closed).toBe(true)

		client.close()
	})

	it('redirects blocked SSE clients to the adminAccess page when external auth is required', async () => {
		const onBlocked = vi.fn()
		const readState = vi.fn(async () => ({
			state: 'login_required' as const,
			method: 'oidc' as const,
		}))
		vi.stubGlobal('EventSource', FakeEventSource)

		const client = sse({
			url: 'http://local/sse',
			adminAccess: {
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
				redirectPath: RUNTIME_ADMIN_ACCESS_BASE,
			}),
		)
		expect(source!.closed).toBe(true)

		client.close()
	})
})

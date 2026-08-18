import { describe, expect, it, vi } from 'vitest'
import {
	WorkbenchEventsService,
	type SseChannel,
} from '../../src/services/workbench/resources/WorkbenchEventsService'

type Listener = () => void

function fixture() {
	const logger = {
		error: vi.fn(),
		warn: vi.fn(),
	}
	const service = new WorkbenchEventsService({ logger } as never, undefined)
	return { logger, service }
}

function ownerFixture() {
	const logger = {
		error: vi.fn(),
		warn: vi.fn(),
	}
	const owner = {
		logger,
		effects: {
			defer: vi.fn((cleanup: () => void) => {
				let active = true
				return {
					dispose: vi.fn(() => {
						if (!active) return
						active = false
						cleanup()
					}),
				}
			}),
		},
	}
	return { logger, owner }
}

function sessionFixture(namespace = 'resource') {
	const listeners = new Map<string, Set<Listener>>()
	const session = {
		isConnected: true,
		state: {
			requested: new Map([['stream', namespace]]),
			handlers: new Map(),
		},
		once: vi.fn((event: string, cb: Listener) => {
			let callbacks = listeners.get(event)
			if (!callbacks) {
				callbacks = new Set()
				listeners.set(event, callbacks)
			}
			callbacks.add(cb)
		}),
		getRequest: () => new Request('http://local.test/events'),
		push: vi.fn(),
	}

	const disconnect = () => {
		session.isConnected = false
		const callbacks = [...(listeners.get('disconnected') ?? [])]
		listeners.delete('disconnected')
		for (const cb of callbacks) cb()
	}

	return { disconnect, session }
}

describe('WorkbenchEventsService failure containment', () => {
	it('reports detached subscription failures instead of leaking a rejected promise', async () => {
		const { logger, service } = fixture()
		const failure = new Error('attach failed')
		vi.spyOn(service as never, 'attachSubscriptionToSession').mockRejectedValue(failure)
		const session = {
			state: { requested: new Map([['stream', 'resource']]), handlers: new Map() },
			once: vi.fn(),
		}

		;(service as any).attachSession(session, {}, new URLSearchParams())
		await vi.waitFor(() => {
			expect(logger.error).toHaveBeenCalledWith('Workbench stream subscription attach failed', {
				error: failure,
				key: 'stream',
			})
		})
	})

	it('contains synchronous and asynchronous cleanup failures', async () => {
		const { logger, service } = fixture()
		const synchronous = new Error('sync cleanup failed')
		const asynchronous = new Error('async cleanup failed')

		expect(() =>
			(service as any).runCleanup(() => {
				throw synchronous
			}, 'sync'),
		).not.toThrow()
		;(service as any).runCleanup(() => Promise.reject(asynchronous), 'async')

		await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(2))
		expect(logger.warn).toHaveBeenCalledWith('cleanup failed for "{namespace}"', {
			namespace: 'sync',
			error: synchronous,
		})
		expect(logger.warn).toHaveBeenCalledWith('cleanup failed for "{namespace}"', {
			namespace: 'async',
			error: asynchronous,
		})
	})

	it('contains abort callback failures during namespace detach', async () => {
		const { logger, service } = fixture()
		const { owner } = ownerFixture()
		const { session } = sessionFixture()
		const failure = new Error('abort failed')
		const unregister = service.registerResourceFor(owner as never, 'resource', (channel) => {
			channel.onAbort(() => {
				throw failure
			})
		})

		;(service as any).attachSession(session, {}, new URLSearchParams())
		await vi.waitFor(() => expect(session.state.handlers.has('stream')).toBe(true))

		expect(() => unregister()).not.toThrow()
		expect(logger.warn).toHaveBeenCalledWith('abort callback failed for "{namespace}"', {
			namespace: 'resource',
			error: failure,
		})
	})
})

describe('WorkbenchEventsService lifecycle cleanup', () => {
	it('closes a detached channel and drops late sends from a pending handler', async () => {
		const { service } = fixture()
		const { owner } = ownerFixture()
		const { session } = sessionFixture()
		const events: string[] = []
		let release!: () => void
		const gate = new Promise<void>((resolve) => (release = resolve))
		let channel!: SseChannel

		const unregister = service.registerResourceFor(owner as never, 'resource', async (next) => {
			channel = next
			events.push(`closed:${next.closed}`)
			next.onAbort(() => events.push('abort'))
			next.emit('snapshot', { stage: 'entered' })
			await gate
			events.push(`late-closed:${next.closed}`)
			next.emit('snapshot', { stage: 'late' })
			return () => events.push('cleanup')
		})

		;(service as any).attachSession(session, {}, new URLSearchParams())
		await vi.waitFor(() => expect(events).toContain('closed:false'))
		expect(session.push).toHaveBeenCalledOnce()

		unregister()

		expect(channel.closed).toBe(true)
		expect(events).toContain('abort')
		expect(session.state.handlers.has('stream')).toBe(false)

		release()
		await vi.waitFor(() => expect(events).toContain('cleanup'))

		expect(events).toEqual(['closed:false', 'abort', 'late-closed:true', 'cleanup'])
		expect(session.push).toHaveBeenCalledOnce()
	})

	it('runs stream cleanup once when owner withdrawal is followed by browser disconnect', async () => {
		const { service } = fixture()
		const { owner } = ownerFixture()
		const { disconnect, session } = sessionFixture()
		const events: string[] = []

		const unregister = service.registerResourceFor(owner as never, 'resource', (channel) => {
			events.push(`attach:${channel.namespace}:${channel.ctx === owner}`)
			return () => events.push('cleanup')
		})

		;(service as any).attachSession(session, {}, new URLSearchParams())
		await vi.waitFor(() =>
			expect(session.state.handlers.get('stream')?.cleanup).toBeTypeOf('function'),
		)

		unregister()

		expect(service.hasResource('resource')).toBe(false)
		expect(events).toEqual(['attach:stream:true', 'cleanup'])
		expect(session.state.handlers.has('stream')).toBe(false)
		expect((service as any).pendingByNamespace.get('resource')?.get(session)?.has('stream')).toBe(
			true,
		)

		disconnect()

		expect(events).toEqual(['attach:stream:true', 'cleanup'])
		expect((service as any).pendingByNamespace.has('resource')).toBe(false)
	})

	it('runs stream cleanup once when browser disconnect is followed by owner withdrawal', async () => {
		const { service } = fixture()
		const { owner } = ownerFixture()
		const { disconnect, session } = sessionFixture()
		const events: string[] = []

		const unregister = service.registerResourceFor(owner as never, 'resource', (channel) => {
			events.push(`attach:${channel.namespace}:${channel.ctx === owner}`)
			return () => events.push('cleanup')
		})

		;(service as any).attachSession(session, {}, new URLSearchParams())
		await vi.waitFor(() =>
			expect(session.state.handlers.get('stream')?.cleanup).toBeTypeOf('function'),
		)

		disconnect()

		expect(events).toEqual(['attach:stream:true', 'cleanup'])
		expect(session.state.handlers.has('stream')).toBe(false)
		expect((service as any).pendingByNamespace.has('resource')).toBe(false)

		unregister()

		expect(service.hasResource('resource')).toBe(false)
		expect(events).toEqual(['attach:stream:true', 'cleanup'])
	})
})

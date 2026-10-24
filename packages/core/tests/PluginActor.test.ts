import { describe, expect, it, vi } from 'vitest'

import type { PluginLifecycleAdapter } from '../src/plugins/composition/BasePlugin'
import { LATE_INIT_CLEANUP_ERROR } from '../src/plugins/composition/symbols'
import { PluginLifecycleActor } from '../src/plugins/runtime/PluginActor'

describe('PluginLifecycleActor', () => {
	it('drains an unstarted generation through stopping without an illegal follow-up transition', async () => {
		const drain = vi.fn(async () => {})
		const actorErrors: unknown[] = []
		const runtime: PluginLifecycleAdapter = { drain }
		const actor = new PluginLifecycleActor({}, { id: 'idle-generation', runtime })
		actor.subscribe({ error: (error) => actorErrors.push(error) })

		actor.send({ type: 'STOP' })
		const stopped = await actor.waitForStopped(1_000)

		expect(stopped.value).toBe('stopped')
		expect(drain).toHaveBeenCalledOnce()
		expect(actorErrors).toEqual([])
	})

	it('does not admit init when STOP is queued before START runs', async () => {
		const init = vi.fn(async () => {})
		const drain = vi.fn(async () => {})
		const actor = new PluginLifecycleActor({}, { id: 'queued-stop', runtime: { init, drain } })
		actor.send({ type: 'START' })
		actor.send({ type: 'STOP' })
		await actor.waitForStopped(1_000)
		expect(init).not.toHaveBeenCalled()
		expect(drain).toHaveBeenCalledOnce()
	})

	it.each(['start', 'drain'] as const)(
		'aborts pending init immediately and reports a late %s failure without publishing running',
		async (phase) => {
			const pending = Promise.withResolvers<void>()
			const started = Promise.withResolvers<AbortSignal>()
			const drained = Promise.withResolvers<void>()
			const onLateError = vi.fn()
			const finalize = vi.fn()
			const drain = vi.fn(async () => drained.resolve())
			const actor = new PluginLifecycleActor(
				{ onLateError },
				{
					id: 'pending-init',
					runtime: {
						init: async (signal) => {
							started.resolve(signal)
							await pending.promise
						},
						finalize,
						drain,
					},
				},
			)
			const published: string[] = []
			actor.subscribe((snapshot) => published.push(snapshot.value))
			actor.send({ type: 'START' })
			const signal = await started.promise
			actor.send({ type: 'STOP' })
			expect(signal.aborted).toBe(true)
			await drained.promise
			expect(drain).toHaveBeenCalledOnce()

			const error = new Error('late failure')
			if (phase === 'drain') Object.assign(error, { [LATE_INIT_CLEANUP_ERROR]: true })
			pending.reject(error)
			await actor.waitForStopped(1_000)
			expect(onLateError).toHaveBeenCalledExactlyOnceWith(error, phase)
			expect(finalize).not.toHaveBeenCalled()
			expect(published).not.toContain('running')
		},
	)

	it.each(['synchronous', 'deferred'] as const)(
		'releases its error subscription once after a %s runtime failure',
		async (delivery) => {
			const error = new Error('runtime failed')
			const unsubscribe = vi.fn()
			const drain = vi.fn(async () => {})
			let emit!: (error: unknown) => void
			const actor = new PluginLifecycleActor(
				{},
				{
					id: 'runtime-error',
					runtime: {
						drain,
						subscribeErrors(listener) {
							emit = listener
							if (delivery === 'synchronous') listener(error)
							return unsubscribe
						},
					},
				},
			)
			actor.send({ type: 'START' })
			await actor.waitForStable(1_000)
			if (delivery === 'deferred') emit(error)
			const failed = await actor.waitUntil((snapshot) => snapshot.value === 'failing', 1_000)
			expect(failed).toMatchObject({
				value: 'failing',
				context: { err: error, failedStep: 'runtime' },
			})
			expect(unsubscribe).toHaveBeenCalledOnce()
			actor.send({ type: 'STOP' })
			await actor.waitForStopped(1_000)
			expect(drain).toHaveBeenCalledOnce()
			expect(unsubscribe).toHaveBeenCalledOnce()
		},
	)

	it('settles errors queued while installing the subscription before publishing running', async () => {
		const error = new Error('error queued during subscription')
		const unsubscribe = vi.fn()
		const drain = vi.fn(async () => {})
		const actor = new PluginLifecycleActor(
			{},
			{
				id: 'subscription-microtask',
				runtime: {
					drain,
					subscribeErrors(listener) {
						queueMicrotask(() => listener(error))
						return unsubscribe
					},
				},
			},
		)
		const published: string[] = []
		actor.subscribe((snapshot) => published.push(snapshot.value))
		actor.send({ type: 'START' })
		const stable = await actor.waitForStable(1_000)
		expect(stable).toMatchObject({
			value: 'failing',
			context: { err: error, failedStep: 'runtime' },
		})
		expect(published).not.toContain('running')
		expect(unsubscribe).toHaveBeenCalledOnce()
		actor.send({ type: 'STOP' })
		await actor.waitForStopped(1_000)
		expect(drain).toHaveBeenCalledOnce()
		expect(unsubscribe).toHaveBeenCalledOnce()
	})

	it('never starts a stopped generation again', async () => {
		const init = vi.fn(async () => {})
		const drain = vi.fn(async () => {})
		const actor = new PluginLifecycleActor(
			{},
			{ id: 'terminal-generation', runtime: { init, drain } },
		)
		actor.send({ type: 'START' })
		const running = await actor.waitForStable(1_000)
		expect(running.value).toBe('running')
		actor.send({ type: 'STOP' })
		await actor.waitForStopped(1_000)

		const rejected = Promise.withResolvers<unknown>()
		actor.subscribe({ error: rejected.resolve })
		actor.send({ type: 'START' })
		expect(await rejected.promise).toBeInstanceOf(Error)
		expect(actor.getSnapshot().value).toBe('stopped')
		expect(init).toHaveBeenCalledOnce()
		expect(drain).toHaveBeenCalledOnce()
	})

	it('isolates observer failures while another observer stops the running generation', async () => {
		const init = vi.fn(async () => {})
		const drain = vi.fn(async () => {})
		const actor = new PluginLifecycleActor({}, { id: 'observer-stop', runtime: { init, drain } })
		const failure = new Error('snapshot observer failed')
		const report = vi.fn(() => {
			throw new Error('error observer failed')
		})
		actor.subscribe({
			next(snapshot) {
				if (snapshot.value === 'running') throw failure
			},
			error: report,
		})
		const published: string[] = []
		actor.subscribe((snapshot) => {
			published.push(snapshot.value)
			if (snapshot.value === 'running') actor.send({ type: 'STOP' })
		})

		actor.send({ type: 'START' })
		const stopped = await actor.waitForStopped(1_000)
		expect(published).toContain('running')
		expect(published.at(-1)).toBe('stopped')
		expect(report).toHaveBeenCalledWith(failure)
		expect(stopped.context.err).toBeUndefined()
		expect(init).toHaveBeenCalledOnce()
		expect(drain).toHaveBeenCalledOnce()
	})
})

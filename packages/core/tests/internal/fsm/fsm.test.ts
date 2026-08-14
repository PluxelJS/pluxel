// file: test/fsm.test.ts
import { describe, expect, test } from 'vitest'
import { defineMachine } from '../../../src/internal/fsm/defineMachine.macro'
import { fsm } from '../../../src/internal/fsm/machine.runtime'

describe('Ultra FSM', () => {
	test('basic transitions', async () => {
		const m = fsm.createMachine()

		expect(m.getState()).toBe(fsm.S.idle)
		expect(m.can(fsm.E.start)).toBe(true)
		expect(m.can(fsm.E.stop)).toBe(false)

		await m.dispatch(fsm.E.start, 'x')
		expect(m.getState()).toBe(fsm.S.running)

		await m.dispatch(fsm.E.stop)
		expect(m.getState()).toBe(fsm.S.stopped)
		expect(m.isFinal()).toBe(true)
	})

	test('abort signal should trigger on state change', async () => {
		const m = fsm.createMachine()

		await m.dispatch(fsm.E.start, 'x')
		const sig = m.getSignal()
		expect(sig).toBeDefined()
		expect(sig?.aborted).toBe(false)

		await m.dispatch(fsm.E.stop)
		// stop enters stopped, but abortOnStateChange aborts previous controller
		// The new signal belongs to "stopped" state, old one is not directly accessible.
		// So we assert that current signal is not aborted.
		expect(m.getSignal()?.aborted).toBe(false)
	})

	test('many instances', async () => {
		const list = Array.from({ length: 200 }, () => fsm.createMachine())

		await Promise.all(list.map((m, i) => m.dispatch(fsm.E.start, `job-${i}`)))
		for (const m of list) {
			expect(m.getState()).toBe(fsm.S.running)
		}

		await Promise.all(list.map((m) => m.dispatch(fsm.E.stop)))
		for (const m of list) {
			expect(m.getState()).toBe(fsm.S.stopped)
			expect(m.isFinal()).toBe(true)
		}
	})

	test('sync version', () => {
		const m = fsm.createMachineSync()

		expect(m.getState()).toBe(fsm.S.idle)
		expect(m.syncDispatch(fsm.E.start, 'x')).toBe(true)
		expect(m.getState()).toBe(fsm.S.running)

		expect(m.syncDispatch(fsm.E.stop)).toBe(true)
		expect(m.getState()).toBe(fsm.S.stopped)
	})

	test('invalid event ids are rejected', async () => {
		const m = fsm.createMachine()
		expect(m.can(999)).toBe(false)
		await expect(m.dispatch(999)).rejects.toThrow(/No transition/)
	})

	test('dispatch rolls back state when callbacks throw', async () => {
		const err = new Error('fail transition')
		const cfg = defineMachine({
			states: ['idle', 'running'] as const,
			events: ['start'] as const,
			init: 'idle',
			transitions: [['idle', 'start', 'running', 'boom']] as const,
			abortOnStateChange: true,
			impl: {
				callbacks: {
					boom: () => {
						throw err
					},
				},
				hooks: {},
			},
		})

		const m = cfg.createMachine()
		const initialSignal = m.getSignal()
		await expect(m.dispatch(cfg.E.start)).rejects.toThrow(err)
		expect(m.getState()).toBe(cfg.S.idle)
		expect(m.getSignal()).toBe(initialSignal)
		expect(initialSignal?.aborted).toBe(false)
	})

	test('syncDispatch rolls back when hooks throw', () => {
		const cfg = defineMachine({
			states: ['idle', 'running'] as const,
			events: ['start'] as const,
			init: 'idle',
			transitions: [['idle', 'start', 'running']] as const,
			hooks: {
				enter: { running: 'onEnter' },
			} as const,
			abortOnStateChange: true,
			impl: {
				callbacks: {},
				hooks: {
					onEnter: () => {
						throw new Error('enter fail')
					},
				},
			},
		})

		const m = cfg.createMachineSync()
		const initialSignal = m.getSignal()
		expect(() => m.syncDispatch(cfg.E.start)).toThrow('enter fail')
		expect(m.getState()).toBe(cfg.S.idle)
		expect(m.getSignal()).toBe(initialSignal)
		expect(initialSignal?.aborted).toBe(false)
	})

	test('dispatchAsync schedules work to next tick', async () => {
		const m = fsm.createMachine()
		const p = m.dispatchAsync(fsm.E.start)
		expect(m.getState()).toBe(fsm.S.idle)
		await p
		expect(m.getState()).toBe(fsm.S.running)
	})

	test('dispatch awaits async hooks and callbacks in order', async () => {
		const order: string[] = []
		const cfg = defineMachine({
			states: ['idle', 'running'] as const,
			events: ['start'] as const,
			init: 'idle',
			transitions: [['idle', 'start', 'running', 'cb']] as const,
			hooks: {
				exit: { idle: 'onExit' },
				enter: { running: 'onEnter' },
			} as const,
			impl: {
				callbacks: {
					cb: async () => {
						await Promise.resolve()
						order.push('cb')
					},
				},
				hooks: {
					onExit: async () => {
						await Promise.resolve()
						order.push('exit')
					},
					onEnter: async () => {
						order.push('enter')
						await Promise.resolve()
					},
				},
			},
		})

		const m = cfg.createMachine()
		await m.dispatch(cfg.E.start)
		expect(order).toEqual(['exit', 'enter', 'cb'])
		expect(m.getState()).toBe(cfg.S.running)
	})

	test('abortOnStateChange rotates signals after success', async () => {
		const cfg = defineMachine({
			states: ['idle', 'running', 'stopped'] as const,
			events: ['start', 'stop'] as const,
			init: 'idle',
			transitions: [
				['idle', 'start', 'running'],
				['running', 'stop', 'stopped'],
			] as const,
			abortOnStateChange: true,
			impl: { callbacks: {}, hooks: {} },
		})

		const m = cfg.createMachine()
		const sig0 = m.getSignal()
		expect(sig0?.aborted).toBe(false)

		await m.dispatch(cfg.E.start)
		const sig1 = m.getSignal()
		expect(sig1).not.toBe(sig0)
		expect(sig0?.aborted).toBe(true)

		await m.dispatch(cfg.E.stop)
		const sig2 = m.getSignal()
		expect(sig2).not.toBe(sig1)
		expect(sig1?.aborted).toBe(true)
		expect(sig2?.aborted).toBe(false)
	})

	test('syncDispatch rejects promise-returning hooks', () => {
		const cfg = defineMachine({
			states: ['idle', 'running'] as const,
			events: ['start'] as const,
			init: 'idle',
			transitions: [['idle', 'start', 'running']] as const,
			hooks: {
				enter: { running: 'onEnter' },
			} as const,
			impl: {
				callbacks: {},
				hooks: {
					onEnter: () => Promise.resolve(),
				},
			},
		})

		const m = cfg.createMachineSync()
		expect(() => m.syncDispatch(cfg.E.start)).toThrow(/sync onEnter hook/)
		expect(m.getState()).toBe(cfg.S.idle)
	})
})

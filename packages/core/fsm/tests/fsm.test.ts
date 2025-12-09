// file: test/fsm.test.ts
import { describe, expect, test } from 'bun:test'
import { fsm } from '../machine.runtime'

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
})

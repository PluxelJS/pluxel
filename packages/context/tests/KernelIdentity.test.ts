import { expect, it, vi } from 'vitest'

it('keeps independent evaluations isolated and diagnoses foreign Context receivers', async () => {
	const first = await import('../src')
	vi.resetModules()
	const second = await import('../src')
	const secondInternal = await import('../src/internal')
	abstract class Value {
		abstract value: number
	}
	const firstRoot = first
		.createContextHost({
			name: 'first',
			services: [first.installRootService(Value, { create: () => ({ value: 1 }) })],
		})
		.createRoot()
	const secondRoot = second
		.createContextHost({
			name: 'second',
			services: [second.installRootService(Value, { create: () => ({ value: 2 }) })],
		})
		.createRoot()
	expect(firstRoot.service(Value).value).toBe(1)
	expect(secondRoot.service(Value).value).toBe(2)
	expect(() => secondInternal.resolveContextService(firstRoot as never, Value)).toThrow(
		'different evaluated Context kernel',
	)
})
it('diagnoses invalid receivers without leaking failures from hostile tag getters', async () => {
	const kernel = await import('../src/internal')
	abstract class Value {
		abstract value: number
	}
	const hostile = Object.create(null)
	Object.defineProperty(hostile, Symbol.toStringTag, {
		get() {
			throw new Error('hostile getter')
		},
	})
	expect(() => kernel.resolveContextService(hostile as never, Value)).toThrow(
		'Invalid Context implementation',
	)
})

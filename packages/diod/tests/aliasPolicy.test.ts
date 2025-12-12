import { describe, expect, it } from 'bun:test'

import { ContainerBuilder } from '../src/builder'

describe('diod aliasPolicy', () => {
	it('firstWins resolves abstract alias to the first provider', () => {
		abstract class Abs {}
		class A extends Abs {}
		class B extends Abs {}
		class Consumer {
			constructor(public dep: Abs) {}
		}

		const b = new ContainerBuilder()
		b.registerAndUse(A).asSingleton().addAlias(Abs)
		b.registerAndUse(B).asSingleton().addAlias(Abs)
		b.registerAndUse(Consumer).asSingleton().withDependencies([Abs])

		const built = b.build({ autowire: false, aliasPolicy: 'firstWins' })
		expect(built.ok).toBe(true)
		if (!built.ok) return

		const container = built.val
		expect(container.getResult(Abs).ok).toBe(true)
		expect(container.getResult(Abs).val).toBeInstanceOf(A)

		const consumer = container.getResult(Consumer).val as Consumer
		expect(consumer.dep).toBeInstanceOf(A)

		expect(container.dependents.get(A)?.has(Consumer)).toBe(true)
		expect(container.dependents.get(B)?.has(Consumer) ?? false).toBe(false)
	})

	it('lastWins resolves abstract alias to the last provider', () => {
		abstract class Abs {}
		class A extends Abs {}
		class B extends Abs {}
		class Consumer {
			constructor(public dep: Abs) {}
		}

		const b = new ContainerBuilder()
		b.registerAndUse(A).asSingleton().addAlias(Abs)
		b.registerAndUse(B).asSingleton().addAlias(Abs)
		b.registerAndUse(Consumer).asSingleton().withDependencies([Abs])

		const built = b.build({ autowire: false, aliasPolicy: 'lastWins' })
		expect(built.ok).toBe(true)
		if (!built.ok) return

		const container = built.val
		expect(container.getResult(Abs).ok).toBe(true)
		expect(container.getResult(Abs).val).toBeInstanceOf(B)

		const consumer = container.getResult(Consumer).val as Consumer
		expect(consumer.dep).toBeInstanceOf(B)

		expect(container.dependents.get(A)?.has(Consumer) ?? false).toBe(false)
		expect(container.dependents.get(B)?.has(Consumer)).toBe(true)
	})

	it('error rejects alias conflicts deterministically', () => {
		abstract class Abs {}
		class A extends Abs {}
		class B extends Abs {}

		const b = new ContainerBuilder()
		b.registerAndUse(A).asSingleton().addAlias(Abs)
		b.registerAndUse(B).asSingleton().addAlias(Abs)

		const built = b.build({ autowire: false, aliasPolicy: 'error' })
		expect(built.ok).toBe(false)
		if (built.ok) return

		expect(built.err.errors.some((e) => e.kind === 'AliasConflict')).toBe(true)
	})
})

import { describe, expect, it } from 'vitest'
import {
	classProvider,
	DraftGraph,
	factoryProvider,
	type GraphBuildError,
	valueProvider,
} from '../../src/internal/di'

class Clock {
	now() {
		return 42
	}
}

class Logger {
	public readonly id = Symbol('logger')
}

class UsesLogger {
	constructor(public readonly logger: Logger) {}
}

class A {
	constructor(public readonly b: B) {}
}

class B {
	constructor(public readonly a: A) {}
}

const expectBuildError = (
	error: GraphBuildError,
	kind: GraphBuildError['issues'][number]['kind'],
) => {
	expect(error.issues.some((issue) => issue.kind === kind)).toBe(true)
}

describe('DraftGraph', () => {
	it('builds a graph and resolves explicit class dependencies', () => {
		const draft = new DraftGraph()
		draft.put(classProvider({ key: Logger, use: Logger }))
		draft.put(classProvider({ key: UsesLogger, deps: [Logger], use: UsesLogger }))

		const built = draft.build()
		expect(built.ok).toBe(true)
		if (!built.ok) return

		const instance = built.val.runtime.ensure<UsesLogger>(UsesLogger)
		expect(instance).toBeInstanceOf(UsesLogger)
		expect(instance.logger).toBeInstanceOf(Logger)
		expect(built.val.graph.resolve(UsesLogger)).toBe(UsesLogger)

		built.val.commit()
		expect(draft.graph.resolve(UsesLogger)).toBe(UsesLogger)
	})

	it('reports missing dependencies', () => {
		const draft = new DraftGraph()
		draft.put(classProvider({ key: UsesLogger, deps: [Logger], use: UsesLogger }))

		const built = draft.build()
		expect(built.ok).toBe(false)
		if ('err' in built) expectBuildError(built.err, 'MissingDependency')
	})

	it('reports invalid value declarations and can recover on the next build', () => {
		const TOKEN = Symbol('TOKEN')
		const BAD = Symbol('BAD')
		const GOOD = Symbol('GOOD')
		const draft = new DraftGraph()

		draft.put(valueProvider({ key: TOKEN, use: 42 }))
		draft.put(valueProvider({ key: BAD, deps: [TOKEN], use: 1 }))

		const first = draft.build()
		expect(first.ok).toBe(false)
		if ('err' in first) expectBuildError(first.err, 'InvalidDeclaration')

		draft.remove(BAD)
		draft.put(
			factoryProvider({
				key: GOOD,
				deps: [TOKEN],
				use: (value) => ({ value }),
			}),
		)

		const second = draft.build()
		expect(second.ok).toBe(true)
		if (!second.ok) return

		expect(second.val.runtime.ensure<{ value: number }>(GOOD)).toEqual({ value: 42 })
	})

	it('reports circular dependencies', () => {
		const draft = new DraftGraph()
		draft.put(classProvider({ key: A, deps: [B], use: A }))
		draft.put(classProvider({ key: B, deps: [A], use: B }))

		const built = draft.build()
		expect(built.ok).toBe(false)
		if ('err' in built) expectBuildError(built.err, 'CircularDependency')
	})

	it('reports token conflicts against implicit self tokens', () => {
		const draft = new DraftGraph()
		draft.put(classProvider({ key: Logger, use: Logger }))
		draft.put(classProvider({ key: UsesLogger, tokens: [Logger], use: UsesLogger }))

		const built = draft.build()
		expect(built.ok).toBe(false)
		if ('err' in built) expectBuildError(built.err, 'TokenConflict')
	})

	it('tracks token retargeting and affected dependents across replacement', () => {
		const BASE = Symbol('BASE')

		class ImplV1 {
			public readonly version = 'v1'
		}

		class ImplV2 {
			public readonly version = 'v2'
		}

		class Consumer {
			constructor(public readonly impl: ImplV1 | ImplV2) {}
		}

		const draft = new DraftGraph()
		draft.put(classProvider({ key: ImplV1, tokens: [BASE], use: ImplV1 }))
		draft.put(classProvider({ key: Consumer, deps: [BASE], use: Consumer }))
		const first = draft.build()
		expect(first.ok).toBe(true)
		if (!first.ok) return
		first.val.commit()

		draft.remove(ImplV1)
		draft.put(classProvider({ key: ImplV2, tokens: [BASE], use: ImplV2 }))

		const second = draft.build()
		expect(second.ok).toBe(true)
		if (!second.ok) return

		expect(second.val.delta.added).toEqual([])
		expect(second.val.delta.removed).toEqual([])
		expect(second.val.delta.replaced).toContainEqual({ from: ImplV1, to: ImplV2 })
		expect(second.val.delta.affected).toContain(Consumer)
		expect(second.val.delta.retargetedTokens).toContainEqual({
			token: BASE,
			from: ImplV1,
			to: ImplV2,
		})
		expect(second.val.graph.depsOf(Consumer)).toEqual([ImplV2])

		const instance = second.val.runtime.ensure<Consumer>(Consumer)
		expect(instance.impl).toBeInstanceOf(ImplV2)
	})

	it('preserves declaration identity for consumers affected only by token retarget', () => {
		const BASE = Symbol('BASE')

		class ImplV1 {}
		class ImplV2 {}
		class Consumer {
			constructor(public readonly dep: ImplV1 | ImplV2) {}
		}

		const draft = new DraftGraph()
		draft.put(classProvider({ key: ImplV1, tokens: [BASE], use: ImplV1 }))
		draft.put(classProvider({ key: Consumer, deps: [BASE], use: Consumer }))

		const first = draft.build()
		expect(first.ok).toBe(true)
		if (!first.ok) return
		const beforeDecl = first.val.graph.declaration(Consumer)
		first.val.commit()

		draft.remove(ImplV1)
		draft.put(classProvider({ key: ImplV2, tokens: [BASE], use: ImplV2 }))

		const second = draft.build()
		expect(second.ok).toBe(true)
		if (!second.ok) return

		expect(second.val.graph.declaration(Consumer)).toBe(beforeDecl)
		expect(second.val.graph.depsOf(Consumer)).toEqual([ImplV2])
	})

	it('replaces a node in place while keeping alias retarget semantics', () => {
		const BASE = Symbol('BASE')

		class ImplV1 {}
		class ImplV2 {}
		class Consumer {
			constructor(public readonly dep: ImplV1 | ImplV2) {}
		}

		const draft = new DraftGraph()
		draft.put(classProvider({ key: ImplV1, tokens: [BASE], use: ImplV1 }))
		draft.put(classProvider({ key: Consumer, deps: [BASE], use: Consumer }))

		const first = draft.build()
		expect(first.ok).toBe(true)
		if (!first.ok) return
		first.val.commit()

		draft.replace(ImplV1, classProvider({ key: ImplV2, tokens: [BASE, ImplV1], use: ImplV2 }))

		const second = draft.build()
		expect(second.ok).toBe(true)
		if (!second.ok) return

		expect(second.val.delta.removed).toEqual([])
		expect(second.val.delta.added).toEqual([])
		expect(second.val.delta.replaced).toContainEqual({ from: ImplV1, to: ImplV2 })
		expect(second.val.delta.affected).toContain(Consumer)
		expect(second.val.graph.resolve(BASE)).toBe(ImplV2)
		expect(second.val.graph.resolve(ImplV1)).toBe(ImplV2)
		expect(second.val.graph.depsOf(Consumer)).toEqual([ImplV2])
	})

	it('exposes retain and fresh cache behavior', () => {
		let created = 0
		const FRESH = Symbol('fresh')
		const draft = new DraftGraph()

		draft.put(
			factoryProvider({
				key: Clock,
				cache: 'retain',
				use: () => {
					created += 1
					return { kind: 'retain', n: created }
				},
			}),
		)
		draft.put(
			factoryProvider({
				key: FRESH,
				cache: 'fresh',
				use: () => ({ kind: 'fresh', id: Symbol('fresh') }),
			}),
		)

		const built = draft.build()
		expect(built.ok).toBe(true)
		if (!built.ok) return

		const retainA = built.val.runtime.ensure<{ kind: string; n: number }>(Clock)
		const retainB = built.val.runtime.ensure<{ kind: string; n: number }>(Clock)
		expect(retainA).toBe(retainB)
		expect(created).toBe(1)

		const freshA = built.val.runtime.ensure<{ kind: string; id: symbol }>(FRESH)
		const freshB = built.val.runtime.ensure<{ kind: string; id: symbol }>(FRESH)
		expect(freshA).not.toBe(freshB)
	})

	it('supports value providers and runtime peek/delete', () => {
		const TOKEN = Symbol('VALUE')
		const value = { answer: 42 }
		const draft = new DraftGraph()
		draft.put(valueProvider({ key: TOKEN, use: value }))

		const built = draft.build()
		expect(built.ok).toBe(true)
		if (!built.ok) return

		expect(built.val.runtime.peek(TOKEN)).toBeUndefined()
		expect(built.val.runtime.ensure<typeof value>(TOKEN)).toBe(value)
		expect(built.val.runtime.peek<typeof value>(TOKEN)).toBe(value)
		built.val.runtime.delete(TOKEN)
		expect(built.val.runtime.peek(TOKEN)).toBeUndefined()
	})

	it('invalidates retain slot cache after deleteMany and tracks active nodes without tombstones', () => {
		let created = 0

		class Service {
			public readonly id = ++created
		}

		const draft = new DraftGraph()
		draft.put(classProvider({ key: Service, use: Service }))

		const first = draft.build()
		expect(first.ok).toBe(true)
		if (!first.ok) return
		first.val.commit()

		expect(draft.graph.activeCount()).toBe(1)

		const runtime = first.val.runtime
		const a = runtime.ensure<Service>(Service)
		const b = runtime.ensure<Service>(Service)
		expect(a).toBe(b)
		expect(created).toBe(1)

		runtime.deleteMany([Service])
		expect(runtime.peek(Service)).toBeUndefined()

		const c = runtime.ensure<Service>(Service)
		expect(c).not.toBe(a)
		expect(created).toBe(2)

		draft.remove(Service)
		const second = draft.build()
		expect(second.ok).toBe(true)
		if (!second.ok) return
		second.val.commit()
		expect(draft.graph.activeCount()).toBe(0)
	})

	it('commits a built snapshot without discarding newer draft mutations', () => {
		const draft = new DraftGraph()
		draft.put(classProvider({ key: Logger, use: Logger }))

		const first = draft.build()
		expect(first.ok).toBe(true)
		if (!first.ok) return

		draft.put(classProvider({ key: UsesLogger, deps: [Logger], use: UsesLogger }))

		first.val.commit()
		expect(draft.graph.has(Logger)).toBe(true)
		expect(draft.graph.has(UsesLogger)).toBe(false)

		const second = draft.build()
		expect(second.ok).toBe(true)
		if (!second.ok) return

		expect(second.val.delta.added).toEqual([UsesLogger])
		const instance = second.val.runtime.ensure<UsesLogger>(UsesLogger)
		expect(instance.logger).toBeInstanceOf(Logger)

		second.val.commit()
		expect(draft.graph.has(UsesLogger)).toBe(true)
	})
})

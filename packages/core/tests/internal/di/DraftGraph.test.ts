import { describe, expect, it, vi } from 'vitest'
import {
	classProvider,
	DraftGraph,
	factoryProvider,
	type GraphBuildError,
	valueProvider,
} from '../../../src/internal/di'

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

	it('reports cycles formed by required and optional ordering edges', () => {
		const draft = new DraftGraph()
		draft.put(classProvider({ key: A, deps: [B], use: A }))
		draft.put(classProvider({ key: B, optionalDeps: [A], use: B }))

		const built = draft.build()
		expect(built.ok).toBe(false)
		if ('err' in built) expectBuildError(built.err, 'CircularDependency')
	})

	it('builds a 12,000-node dependency chain without using the JavaScript call stack', () => {
		const draft = createDeepDraft(12_000, false)
		const built = draft.build()
		expect(built.ok).toBe(true)
	})

	it('reports a 12,000-node cycle without leaking RangeError', () => {
		const draft = createDeepDraft(12_000, true)
		const built = draft.build()
		expect(built.ok).toBe(false)
		if (!('err' in built)) throw new Error('expected the deep cycle build to fail')
		expect(built.err).not.toBeInstanceOf(RangeError)
		const cycle = built.err.issues.find((issue) => issue.kind === 'CircularDependency')
		expect(cycle?.kind === 'CircularDependency' ? cycle.chain : []).toHaveLength(12_001)
	})

	it('collects a multi-root shared-tail cascade once in committed and pending drafts', () => {
		const ROOT_A = Symbol('ROOT_A')
		const ROOT_B = Symbol('ROOT_B')
		const LEFT = Symbol('LEFT')
		const RIGHT = Symbol('RIGHT')
		const SHARED = Symbol('SHARED')
		const TAIL = Symbol('TAIL')
		const PENDING = Symbol('PENDING')
		const draft = new DraftGraph()
		for (const [key, deps] of [
			[ROOT_A, []],
			[ROOT_B, []],
			[LEFT, [ROOT_A]],
			[RIGHT, [ROOT_B]],
			[SHARED, [LEFT, RIGHT]],
			[TAIL, [SHARED]],
		] as const) {
			draft.put(factoryProvider({ key, deps, use: (): undefined => undefined }))
		}
		const built = draft.build()
		if ('err' in built) throw built.err
		built.val.commit()

		const dependentReads = vi.spyOn(draft.graph, 'dependentSlotsOf')
		expect(draft.collectCascadeTargetsFrom([ROOT_A, ROOT_B])).toEqual(
			new Set([ROOT_A, ROOT_B, LEFT, RIGHT, SHARED, TAIL]),
		)
		expect(dependentReads).toHaveBeenCalledTimes(6)
		for (const key of [SHARED, TAIL]) {
			const slot = draft.graph.slotOf(key)!
			expect(dependentReads.mock.calls.filter(([read]) => read === slot)).toHaveLength(1)
		}

		draft.put(factoryProvider({ key: PENDING, deps: [TAIL], use: (): undefined => undefined }))
		expect(draft.collectCascadeTargetsFrom([ROOT_A, ROOT_B])).toEqual(
			new Set([ROOT_A, ROOT_B, LEFT, RIGHT, SHARED, TAIL, PENDING]),
		)
	})

	it('accepts a missing optional token and links its consumer when a provider appears', () => {
		const OPTIONAL = Symbol('OPTIONAL')
		class OptionalProvider {}
		class OptionalConsumer {}
		const draft = new DraftGraph()
		draft.put(
			classProvider({ key: OptionalConsumer, optionalDeps: [OPTIONAL], use: OptionalConsumer }),
		)

		const absent = draft.build()
		expect(absent.ok).toBe(true)
		if (!absent.ok) return
		expect(absent.val.graph.optionalDepsOf(OptionalConsumer)).toEqual([])
		absent.val.commit()

		draft.put(classProvider({ key: OptionalProvider, tokens: [OPTIONAL], use: OptionalProvider }))
		const present = draft.build()
		expect(present.ok).toBe(true)
		if (!present.ok) return
		expect(present.val.graph.optionalDepsOf(OptionalConsumer)).toEqual([OptionalProvider])
		expect(present.val.graph.optionalDependentsOf(OptionalProvider)).toEqual([OptionalConsumer])
		expect(present.val.delta.affected).toContain(OptionalConsumer)
		expect(absent.val.graph.optionalDepsOf(OptionalConsumer)).toEqual([])
		present.val.commit()

		draft.remove(OptionalProvider)
		const removed = draft.build()
		expect(removed.ok).toBe(true)
		if (!removed.ok) return
		expect(removed.val.graph.optionalDepsOf(OptionalConsumer)).toEqual([])
		expect(removed.val.graph.optionalDependentsOf(OptionalProvider)).toEqual([])
		expect(removed.val.delta.affected).toContain(OptionalConsumer)
		expect(present.val.graph.optionalDepsOf(OptionalConsumer)).toEqual([OptionalProvider])
		expect(present.val.graph.optionalDependentsOf(OptionalProvider)).toEqual([OptionalConsumer])
	})

	it('retargets optional consumers when an implicit key token appears incrementally', () => {
		const OPTIONAL = Symbol('OPTIONAL')
		class OptionalConsumer {}
		const draft = new DraftGraph()
		draft.put(
			classProvider({ key: OptionalConsumer, optionalDeps: [OPTIONAL], use: OptionalConsumer }),
		)

		const absent = draft.build()
		expect(absent.ok).toBe(true)
		if (!absent.ok) return
		absent.val.commit()

		draft.put(valueProvider({ key: OPTIONAL, use: 42 }))
		const present = draft.build()
		expect(present.ok).toBe(true)
		if (!present.ok) return
		expect(present.val.graph.optionalDepsOf(OptionalConsumer)).toEqual([OPTIONAL])
		expect(present.val.graph.optionalDependentsOf(OPTIONAL)).toEqual([OptionalConsumer])
		expect(new Set(present.val.delta.affected)).toEqual(new Set([OPTIONAL, OptionalConsumer]))
	})

	it('reuses optional indexes when an incremental build does not touch optional edges', () => {
		class RequiredProvider {}
		class RequiredConsumer {}
		class Independent {}

		const draft = new DraftGraph()
		draft.put(classProvider({ key: RequiredProvider, use: RequiredProvider }))
		draft.put(
			classProvider({
				key: RequiredConsumer,
				deps: [RequiredProvider],
				use: RequiredConsumer,
			}),
		)

		const first = draft.build()
		expect(first.ok).toBe(true)
		if (!first.ok) return
		first.val.commit()

		const optionalDeps = first.val.graph.optionalDepsBySlot()
		const optionalDependents = first.val.graph.optionalDependentsBySlot()
		const optionalConsumers = first.val.graph.optionalTokenConsumerSlots()

		draft.put(classProvider({ key: Independent, use: Independent }))
		const second = draft.build()
		expect(second.ok).toBe(true)
		if (!second.ok) return

		expect(second.val.graph.optionalDepsBySlot()).toBe(optionalDeps)
		expect(second.val.graph.optionalDependentsBySlot()).toBe(optionalDependents)
		expect(second.val.graph.optionalTokenConsumerSlots()).toBe(optionalConsumers)
	})

	it('copies touched optional indexes without mutating the committed snapshot', () => {
		const TOKEN = Symbol('TOKEN')
		class Provider {}
		class RequiredConsumer {}
		class OptionalConsumer {}

		const draft = new DraftGraph()
		draft.put(classProvider({ key: Provider, tokens: [TOKEN], use: Provider }))
		draft.put(classProvider({ key: RequiredConsumer, deps: [TOKEN], use: RequiredConsumer }))
		draft.put(
			classProvider({
				key: OptionalConsumer,
				optionalDeps: [TOKEN],
				use: OptionalConsumer,
			}),
		)

		const first = draft.build()
		expect(first.ok).toBe(true)
		if (!first.ok) return
		first.val.commit()

		const committed = first.val.graph
		const optionalDeps = committed.optionalDepsBySlot()
		const optionalDependents = committed.optionalDependentsBySlot()
		const optionalConsumers = committed.optionalTokenConsumerSlots()

		draft.replace(RequiredConsumer, classProvider({ key: RequiredConsumer, use: RequiredConsumer }))
		draft.replace(OptionalConsumer, classProvider({ key: OptionalConsumer, use: OptionalConsumer }))

		const second = draft.build()
		expect(second.ok).toBe(true)
		if (!second.ok) return

		expect(second.val.graph.optionalDepsBySlot()).not.toBe(optionalDeps)
		expect(second.val.graph.optionalDependentsBySlot()).not.toBe(optionalDependents)
		expect(second.val.graph.optionalTokenConsumerSlots()).not.toBe(optionalConsumers)
		expect(second.val.graph.optionalDepsOf(OptionalConsumer)).toEqual([])
		expect(second.val.graph.optionalDependentsOf(Provider)).toEqual([])
		expect(second.val.graph.optionalConsumers(TOKEN)).toEqual([])

		expect(committed.depsOf(RequiredConsumer)).toEqual([Provider])
		expect(committed.optionalDepsOf(OptionalConsumer)).toEqual([Provider])
		expect(committed.optionalDependentsOf(Provider)).toEqual([OptionalConsumer])
		expect(committed.optionalConsumers(TOKEN)).toEqual([OptionalConsumer])
	})

	it('does not mutate shared empty dependent lists during replacement retargeting', () => {
		const TOKEN = Symbol('TOKEN')
		class Provider {}
		class ProviderReplacement {}
		class RequiredConsumer {}
		class OptionalConsumer {}
		class Independent {}

		const draft = new DraftGraph()
		draft.put(classProvider({ key: Provider, tokens: [TOKEN], use: Provider }))
		draft.put(classProvider({ key: RequiredConsumer, deps: [TOKEN], use: RequiredConsumer }))
		draft.put(
			classProvider({
				key: OptionalConsumer,
				optionalDeps: [TOKEN],
				use: OptionalConsumer,
			}),
		)
		draft.put(classProvider({ key: Independent, use: Independent }))

		const first = draft.build()
		expect(first.ok).toBe(true)
		if (!first.ok) return
		first.val.commit()

		draft.replace(
			Provider,
			classProvider({ key: Provider, tokens: [TOKEN], use: ProviderReplacement }),
		)
		const second = draft.build()
		expect(second.ok).toBe(true)
		if (!second.ok) return

		expect(second.val.graph.dependentsOf(Provider)).toEqual([RequiredConsumer])
		expect(second.val.graph.optionalDependentsOf(Provider)).toEqual([OptionalConsumer])
		expect(second.val.graph.dependentsOf(RequiredConsumer)).toEqual([])
		expect(second.val.graph.optionalDependentsOf(RequiredConsumer)).toEqual([])
		expect(second.val.graph.dependentsOf(OptionalConsumer)).toEqual([])
		expect(second.val.graph.optionalDependentsOf(OptionalConsumer)).toEqual([])
		expect(second.val.graph.dependentsOf(Independent)).toEqual([])
		expect(second.val.graph.optionalDependentsOf(Independent)).toEqual([])
	})

	it('reuses the token owner index when replacement keeps the same key and aliases', () => {
		const SERVICE = Symbol('SERVICE')
		const ALIAS = Symbol('ALIAS')
		class ServiceV1 {}
		class ServiceV2 {}

		const draft = new DraftGraph()
		draft.put(classProvider({ key: SERVICE, tokens: [ALIAS], use: ServiceV1 }))
		const first = draft.build()
		expect(first.ok).toBe(true)
		if (!first.ok) return
		first.val.commit()

		const tokenOwners = first.val.graph.tokenOwnerSlots()
		draft.replace(SERVICE, classProvider({ key: SERVICE, tokens: [ALIAS], use: ServiceV2 }))

		const second = draft.build()
		expect(second.ok).toBe(true)
		if (!second.ok) return

		expect(second.val.graph.tokenOwnerSlots()).toBe(tokenOwners)
		expect(second.val.graph.resolve(ALIAS)).toBe(SERVICE)
		expect(second.val.runtime.ensure(SERVICE)).toBeInstanceOf(ServiceV2)
	})

	it('builds a fixed-size replacement without enumerating committed snapshot tables', () => {
		class TargetV1 {}
		class TargetV2 {}
		class Consumer {
			constructor(public readonly target: TargetV1 | TargetV2) {}
		}

		const draft = new DraftGraph()
		draft.put(classProvider({ key: TargetV1, use: TargetV1 }))
		draft.put(classProvider({ key: Consumer, deps: [TargetV1], use: Consumer }))
		let farBackground: symbol | undefined
		for (let index = 0; index < 512; index++) {
			const key = Symbol(`background-${index}`)
			farBackground = key
			draft.put(valueProvider({ key, use: index }))
		}
		const first = draft.build()
		expect(first.ok).toBe(true)
		if (!first.ok) return
		first.val.commit()

		const graph = first.val.graph
		const coldRuntime = first.val.runtime as unknown as {
			resolvingMarks: number[]
			retainedKnown: number[]
		}
		expect(graph.slotCount()).toBe(514)
		expect(coldRuntime.resolvingMarks).toHaveLength(0)
		expect(coldRuntime.retainedKnown).toHaveLength(0)
		const failBulkRead = () => {
			throw new Error('incremental build enumerated a committed snapshot table')
		}
		const declarationsBySlot = graph.declarationsBySlot.bind(graph)
		const createsBySlot = graph.createsBySlot.bind(graph)
		const depsBySlot = graph.depsBySlot.bind(graph)
		const dependentsBySlot = graph.dependentsBySlot.bind(graph)
		const tokenConsumerSlots = graph.tokenConsumerSlots.bind(graph)
		graph.declarationsBySlot = failBulkRead as typeof graph.declarationsBySlot
		graph.createsBySlot = failBulkRead as typeof graph.createsBySlot
		graph.depsBySlot = failBulkRead as typeof graph.depsBySlot
		graph.dependentsBySlot = failBulkRead as typeof graph.dependentsBySlot
		graph.tokenConsumerSlots = failBulkRead as typeof graph.tokenConsumerSlots

		try {
			draft.replace(TargetV1, classProvider({ key: TargetV1, use: TargetV2 }))
			const second = draft.build()
			expect(second.ok).toBe(true)
			if (!second.ok) return
			const targetSlot = graph.slotOf(TargetV1)!
			const backgroundSlot = graph.slotOf(farBackground!)!
			expect(second.val.graph.declarationsBySlot().pageIdentity(targetSlot)).not.toBe(
				declarationsBySlot().pageIdentity(targetSlot),
			)
			expect(second.val.graph.declarationsBySlot().pageIdentity(backgroundSlot)).toBe(
				declarationsBySlot().pageIdentity(backgroundSlot),
			)
			expect(second.val.graph.depsBySlot().pageIdentity(backgroundSlot)).toBe(
				depsBySlot().pageIdentity(backgroundSlot),
			)
			expect(second.val.delta.affected).toEqual([TargetV1, Consumer])
			expect(second.val.runtime.ensure<Consumer>(Consumer).target).toBeInstanceOf(TargetV2)
		} finally {
			graph.declarationsBySlot = declarationsBySlot
			graph.createsBySlot = createsBySlot
			graph.depsBySlot = depsBySlot
			graph.dependentsBySlot = dependentsBySlot
			graph.tokenConsumerSlots = tokenConsumerSlots
		}
	})

	it('still validates value providers on the token owner reuse path', () => {
		const SERVICE = Symbol('SERVICE')
		const DEPENDENCY = Symbol('DEPENDENCY')
		const draft = new DraftGraph()

		draft.put(valueProvider({ key: SERVICE, use: 1 }))
		const first = draft.build()
		expect(first.ok).toBe(true)
		if (!first.ok) return
		first.val.commit()

		draft.replace(SERVICE, valueProvider({ key: SERVICE, deps: [DEPENDENCY], use: 2 }))
		const second = draft.build()
		expect(second.ok).toBe(false)
		if ('err' in second) expectBuildError(second.err, 'InvalidDeclaration')
	})

	it('keeps token owner snapshots immutable across incremental add, conflict, and remove', () => {
		const TOKEN_A = Symbol('TOKEN_A')
		const TOKEN_B = Symbol('TOKEN_B')
		class ProviderA {}
		class ProviderB {}
		class ConflictingProvider {}

		const draft = new DraftGraph()
		draft.put(classProvider({ key: ProviderA, tokens: [TOKEN_A], use: ProviderA }))
		const first = draft.build()
		expect(first.ok).toBe(true)
		if (!first.ok) return
		first.val.commit()

		draft.put(classProvider({ key: ProviderB, tokens: [TOKEN_B], use: ProviderB }))
		const second = draft.build()
		expect(second.ok).toBe(true)
		if (!second.ok) return
		expect(first.val.graph.resolve(TOKEN_B)).toBeUndefined()
		expect(second.val.graph.resolve(TOKEN_B)).toBe(ProviderB)
		expect(second.val.graph.tokenOwnerSlots().size).toBe(2)
		second.val.commit()

		draft.put(
			classProvider({ key: ConflictingProvider, tokens: [TOKEN_A], use: ConflictingProvider }),
		)
		const conflict = draft.build()
		expect(conflict.ok).toBe(false)
		if ('err' in conflict) expectBuildError(conflict.err, 'TokenConflict')
		expect(second.val.graph.resolve(TOKEN_A)).toBe(ProviderA)

		draft.reset()
		draft.remove(ProviderB)
		const third = draft.build()
		expect(third.ok).toBe(true)
		if (!third.ok) return
		expect(second.val.graph.resolve(TOKEN_B)).toBe(ProviderB)
		expect(third.val.graph.resolve(TOKEN_B)).toBeUndefined()
		expect([...third.val.graph.tokenOwnerSlots()]).toEqual([
			[TOKEN_A, third.val.graph.slotOf(ProviderA)],
		])
	})

	it('rejects an incremental key that conflicts with an existing explicit token owner', () => {
		const TOKEN = Symbol('TOKEN')
		class ExplicitOwner {}
		const draft = new DraftGraph()
		draft.put(classProvider({ key: ExplicitOwner, tokens: [TOKEN], use: ExplicitOwner }))
		const first = draft.build()
		expect(first.ok).toBe(true)
		if (!first.ok) return
		first.val.commit()

		draft.put(valueProvider({ key: TOKEN, use: 42 }))
		const conflict = draft.build()
		expect(conflict.ok).toBe(false)
		if ('err' in conflict) expectBuildError(conflict.err, 'TokenConflict')
		expect(first.val.graph.resolve(TOKEN)).toBe(ExplicitOwner)
	})

	it('compacts token owner changes across commits without changing map semantics', () => {
		const ROOT_TOKEN = Symbol('ROOT_TOKEN')
		const STABLE_TOKEN = Symbol('STABLE_TOKEN')
		class Provider {}
		class StableProvider {}
		class ReplacementProvider {}
		const draft = new DraftGraph()
		draft.put(classProvider({ key: Provider, tokens: [ROOT_TOKEN], use: Provider }))
		draft.put(classProvider({ key: StableProvider, tokens: [STABLE_TOKEN], use: StableProvider }))
		const first = draft.build()
		expect(first.ok).toBe(true)
		if (!first.ok) return
		first.val.commit()

		draft.replace(Provider, classProvider({ key: Provider, use: Provider }))
		draft.put(
			classProvider({
				key: ReplacementProvider,
				tokens: [ROOT_TOKEN],
				use: ReplacementProvider,
			}),
		)
		const replaced = draft.build()
		expect(replaced.ok).toBe(true)
		if (!replaced.ok) return
		replaced.val.commit()

		const additions = Array.from({ length: 65 }, (_, index) => ({
			key: Symbol(`provider-${index}`),
			token: Symbol(`token-${index}`),
		}))
		for (const { key, token } of additions) {
			draft.put(classProvider({ key, tokens: [token], use: Provider }))
			const added = draft.build()
			expect(added.ok).toBe(true)
			if (!added.ok) return
			added.val.commit()
		}

		const owners = draft.graph.tokenOwnerSlots()
		expect(owners.size).toBe(67)
		expect([...owners.keys()]).toEqual([
			STABLE_TOKEN,
			ROOT_TOKEN,
			...additions.map(({ token }) => token),
		])
		for (const { key, token } of additions) expect(draft.graph.resolve(token)).toBe(key)
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

function createDeepDraft(length: number, cyclic: boolean): DraftGraph {
	const keys = Array.from({ length }, (_, index) => Symbol(`deep-${index}`))
	const draft = new DraftGraph()
	for (let index = 0; index < keys.length; index++) {
		const dependency = index + 1 < keys.length ? keys[index + 1] : cyclic ? keys[0] : undefined
		draft.put(
			factoryProvider({
				key: keys[index]!,
				...(dependency === undefined ? {} : { deps: [dependency] }),
				use: (): undefined => undefined,
			}),
		)
	}
	return draft
}

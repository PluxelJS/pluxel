import { describe, expect, it } from 'vitest'
import {
	classProvider,
	DraftGraph,
	InstanceStore,
	type NodeKey,
	Runtime,
} from '../../../src/internal/di'

function buildOk<M>(draft: DraftGraph<M>) {
	const built = draft.build()
	expect(built.ok).toBe(true)
	if ('err' in built) throw built.err
	return built.val
}

describe('Runtime', () => {
	it('updates token consumer indexes across incremental slot reuse', () => {
		const BASE = Symbol('BASE')

		class Impl {}
		class ConsumerA {
			constructor(public readonly dep: Impl) {}
		}
		class ConsumerB {
			constructor(public readonly dep: Impl) {}
		}
		class ConsumerC {
			constructor(public readonly dep: Impl) {}
		}

		const draft = new DraftGraph()
		draft.put(classProvider({ key: Impl, tokens: [BASE], use: Impl }))
		draft.put(classProvider({ key: ConsumerA, deps: [BASE], use: ConsumerA }))
		draft.put(classProvider({ key: ConsumerB, deps: [BASE], use: ConsumerB }))

		const first = buildOk(draft)
		first.commit()

		expect(new Set(draft.graph.consumers(BASE))).toEqual(new Set([ConsumerA, ConsumerB]))
		expect(draft.graph.tokenConsumerSlotsOf(BASE)).toHaveLength(2)

		draft.remove(ConsumerA)
		const second = buildOk(draft)
		second.commit()

		expect(draft.graph.consumers(BASE)).toEqual([ConsumerB])

		draft.put(classProvider({ key: ConsumerC, deps: [BASE], use: ConsumerC }))
		const third = buildOk(draft)
		third.commit()

		expect(new Set(draft.graph.consumers(BASE))).toEqual(new Set([ConsumerB, ConsumerC]))
		expect(draft.graph.consumers(BASE).filter((key) => key === ConsumerB)).toHaveLength(1)

		const runtime = new Runtime(draft.graph, draft.instances)
		const instance = runtime.ensure<ConsumerC>(ConsumerC)
		expect(instance.dep).toBeInstanceOf(Impl)
	})

	it('drops replaced retain instances on commit while preserving alias resolution', () => {
		const BASE = Symbol('BASE')

		class ImplV1 {
			public readonly version = 'v1'
		}

		class ImplV2 {
			public readonly version = 'v2'
		}

		const draft = new DraftGraph()
		draft.put(classProvider({ key: ImplV1, tokens: [BASE], use: ImplV1 }))

		const first = buildOk(draft)

		const before = first.runtime.ensure<ImplV1>(ImplV1)
		first.commit()
		expect(draft.instances.peek(ImplV1)).toBe(before)

		draft.replace(ImplV1, classProvider({ key: ImplV2, tokens: [BASE, ImplV1], use: ImplV2 }))

		const second = buildOk(draft)
		second.commit()

		expect(draft.instances.peek(ImplV1)).toBeUndefined()

		const runtime = new Runtime(draft.graph, draft.instances)
		const aliased = runtime.ensure<ImplV2>(ImplV1)
		const direct = runtime.ensure<ImplV2>(ImplV2)

		expect(aliased).toBe(direct)
		expect(aliased).toBeInstanceOf(ImplV2)
		expect(aliased).not.toBe(before)
	})

	it('treats token handles consistently for peek ensure and delete', () => {
		const BASE = Symbol('BASE')

		class Service {
			public readonly id = Symbol('service')
		}

		const draft = new DraftGraph()
		draft.put(classProvider({ key: Service, tokens: [BASE], use: Service }))

		const built = buildOk(draft)
		built.commit()

		const runtime = new Runtime(draft.graph, draft.instances)
		const first = runtime.ensure<Service>(BASE)
		expect(runtime.peek<Service>(BASE)).toBe(first)
		expect(runtime.peek<Service>(Service)).toBe(first)

		runtime.delete(BASE)
		expect(runtime.peek(BASE)).toBeUndefined()

		const second = runtime.ensure<Service>(Service)
		expect(second).not.toBe(first)
	})

	it('keeps unrelated retained slots hot after store mutations', () => {
		class CountingStore<K, V> extends InstanceStore<K, V> {
			public peekCalls = 0

			override peek(key: K): V | undefined {
				this.peekCalls += 1
				return super.peek(key)
			}
		}

		class A {
			public readonly id = Symbol('a')
		}

		class B {
			public readonly id = Symbol('b')
		}

		const draft = new DraftGraph()
		draft.put(classProvider({ key: A, use: A }))
		draft.put(classProvider({ key: B, use: B }))

		const built = buildOk(draft)
		built.commit()

		const store = new CountingStore<NodeKey, unknown>()
		const runtime = new Runtime(draft.graph, store)
		runtime.ensure<A>(A)
		runtime.ensure<B>(B)
		const warmPeekCalls = store.peekCalls

		runtime.delete(A)
		const beforeEnsureB = store.peekCalls
		const secondB = runtime.ensure<B>(B)

		expect(secondB).toBeDefined()
		expect(store.peekCalls).toBe(beforeEnsureB)
		expect(beforeEnsureB).toBe(warmPeekCalls)
	})

	it('deleteMany consumes one-shot iterables only once', () => {
		class A {
			public readonly id = Symbol('a')
		}

		class B {
			public readonly id = Symbol('b')
		}

		const draft = new DraftGraph()
		draft.put(classProvider({ key: A, use: A }))
		draft.put(classProvider({ key: B, use: B }))

		const built = buildOk(draft)

		const runtime = built.runtime
		const firstA = runtime.ensure<A>(A)
		const firstB = runtime.ensure<B>(B)

		function* handles() {
			yield A
			yield B
		}

		runtime.deleteMany(handles())

		const secondA = runtime.ensure<A>(A)
		const secondB = runtime.ensure<B>(B)
		expect(secondA).not.toBe(firstA)
		expect(secondB).not.toBe(firstB)
	})
})

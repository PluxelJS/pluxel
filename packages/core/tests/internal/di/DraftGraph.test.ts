import { expect, it } from 'vitest'
import { classProvider, DraftGraph, factoryProvider, valueProvider } from '../../../src/internal/di'

function build(draft: DraftGraph) {
	const built = draft.build()
	if ('err' in built) throw built.err
	return built.val
}

it('retargets required and optional consumers without rewriting their committed snapshot', () => {
	const token = Symbol('service')
	const optional = Symbol('optional consumer')
	class FirstService {}
	class NextService {}
	class Consumer {
		constructor(readonly service: FirstService | NextService) {}
	}
	const draft = new DraftGraph()
	draft.put(classProvider({ key: FirstService, tokens: [token], use: FirstService }))
	draft.put(classProvider({ key: Consumer, deps: [token], use: Consumer }))
	draft.put(factoryProvider({ key: optional, optionalDeps: [token], use: () => ({}) }))
	const first = build(draft)
	first.commit()

	draft.replace(
		FirstService,
		classProvider({ key: NextService, tokens: [token, FirstService], use: NextService }),
	)
	const next = build(draft)
	expect(next.delta.replaced).toEqual([{ from: FirstService, to: NextService }])
	expect(next.delta.affected).toEqual(expect.arrayContaining([Consumer, optional]))
	expect(next.runtime.ensure<Consumer>(Consumer).service).toBeInstanceOf(NextService)
	expect(next.graph.optionalDepsOf(optional)).toEqual([NextService])
	expect(next.graph.optionalDependentsOf(NextService)).toEqual([optional])
	expect(next.graph.optionalDependentsOf(Consumer)).toEqual([])
	expect(next.graph.resolve(FirstService)).toBe(NextService)
	expect(draft.graph).toBe(first.graph)
	next.commit()
	expect(first.graph.resolve(token)).toBe(FirstService)
	expect(first.graph.optionalDepsOf(optional)).toEqual([FirstService])
})

it('links a missing optional dependency when its token appears and withdraws it on removal', () => {
	const token = Symbol('service')
	const consumer = Symbol('consumer')
	const draft = new DraftGraph()
	draft.put(factoryProvider({ key: consumer, optionalDeps: [token], use: () => ({}) }))
	const absent = build(draft)
	absent.commit()
	expect(absent.graph.optionalDepsOf(consumer)).toEqual([])

	draft.put(valueProvider({ key: token, use: 42 }))
	const added = build(draft)
	added.commit()
	expect(added.graph.optionalDepsOf(consumer)).toEqual([token])
	expect(added.delta.affected).toContain(consumer)

	draft.remove(token)
	const removed = build(draft)
	removed.commit()
	expect(removed.graph.optionalDepsOf(consumer)).toEqual([])
	expect(removed.delta.affected).toContain(consumer)
	expect(added.graph.optionalDepsOf(consumer)).toEqual([token])
})

it('rejects an incremental token collision and keeps the committed resolution', () => {
	const token = Symbol('service')
	const provider = Symbol('provider')
	const draft = new DraftGraph()
	draft.put(valueProvider({ key: provider, tokens: [token], use: 1 }))
	build(draft).commit()

	draft.put(valueProvider({ key: token, use: 2 }))
	expect(draft.build()).toMatchObject({ ok: false, err: { issues: [{ kind: 'TokenConflict' }] } })
	expect(draft.graph.resolve(token)).toBe(provider)
})

it('rejects invalid declarations even when the replacement keeps the same tokens', () => {
	const key = Symbol('service')
	const dependency = Symbol('dependency')
	const draft = new DraftGraph()
	draft.put(valueProvider({ key, use: 1 }))
	draft.put(valueProvider({ key: dependency, use: true }))
	build(draft).commit()

	draft.replace(key, valueProvider({ key, deps: [dependency], use: 2 }))
	expect(draft.build()).toMatchObject({
		ok: false,
		err: { issues: [{ kind: 'InvalidDeclaration' }] },
	})
})

it('commits the prepared snapshot while keeping subsequently staged declarations', () => {
	const provider = Symbol('provider')
	const consumer = Symbol('consumer')
	const draft = new DraftGraph()
	draft.put(valueProvider({ key: provider, use: 42 }))
	const prepared = build(draft)

	draft.put(factoryProvider({ key: consumer, deps: [provider], use: (value) => value }))
	prepared.commit()
	expect(draft.graph.has(consumer)).toBe(false)

	const next = build(draft)
	expect(next.runtime.ensure(consumer)).toBe(42)
	next.commit()
	expect(draft.graph.has(consumer)).toBe(true)
})

it('rejects a cycle containing an optional edge', () => {
	const left = Symbol('left')
	const right = Symbol('right')
	const draft = new DraftGraph()
	draft.put(factoryProvider({ key: left, deps: [right], use: () => ({}) }))
	draft.put(factoryProvider({ key: right, optionalDeps: [left], use: () => ({}) }))

	expect(draft.build()).toMatchObject({
		ok: false,
		err: { issues: [{ kind: 'CircularDependency' }] },
	})
})

it('validates deep graphs and reports a cycle without exhausting the JavaScript call stack', () => {
	const keys = Array.from({ length: 12_000 }, () => Symbol())
	const first = keys[0]!
	const last = keys.at(-1)!
	const draft = new DraftGraph()
	for (let index = 0; index < keys.length - 1; index++) {
		draft.put(factoryProvider({ key: keys[index]!, deps: [keys[index + 1]!], use: () => ({}) }))
	}
	draft.put(valueProvider({ key: last, use: true }))
	build(draft).commit()

	draft.replace(last, factoryProvider({ key: last, deps: [first], use: () => ({}) }))
	const cycle = draft.build()
	if (!('err' in cycle)) throw new Error('Expected a cycle through the entire graph')
	const issue = cycle.err.issues.find((candidate) => candidate.kind === 'CircularDependency')
	expect(issue?.chain).toHaveLength(keys.length + 1)
})

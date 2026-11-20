import { expect, it } from 'vitest'
import { DraftGraph, factoryProvider, Runtime } from '../../../src/internal/di'

it('refreshes retained aliases across runtimes after consuming a one-shot invalidation iterable', () => {
	const token = Symbol('alias')
	const first = Symbol('first service')
	const second = Symbol('second service')
	const ephemeral = Symbol('fresh service')
	const draft = new DraftGraph()
	draft.put(factoryProvider({ key: first, tokens: [token], use: () => ({}) }))
	draft.put(factoryProvider({ key: second, use: () => ({}) }))
	draft.put(factoryProvider({ key: ephemeral, cache: 'fresh', use: () => ({}) }))
	const built = draft.build()
	if ('err' in built) throw built.err
	built.val.commit()

	const observer = new Runtime(draft.graph, draft.instances)
	const mutator = new Runtime(draft.graph, draft.instances)
	const oldFirst = observer.ensure(token)
	const oldSecond = observer.ensure(second)
	expect(mutator.ensure(first)).toBe(oldFirst)
	expect(observer.ensure(ephemeral)).not.toBe(observer.ensure(ephemeral))

	function* withdrawn() {
		yield first
		yield second
	}
	mutator.deleteMany(withdrawn())
	expect(observer.peek(token)).toBeUndefined()
	expect(observer.peek(second)).toBeUndefined()
	const newFirst = mutator.ensure(first)
	const newSecond = mutator.ensure(second)
	expect(newFirst).not.toBe(oldFirst)
	expect(newSecond).not.toBe(oldSecond)
	expect(observer.ensure(token)).toBe(newFirst)
	expect(observer.ensure(second)).toBe(newSecond)
})

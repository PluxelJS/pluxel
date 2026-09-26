import { describe, expect, it } from 'vitest'
import { createCommandRegistry, defineCommand, Result } from '../src/index'
import { Type, obj } from '../src/typebox'

const command = (version: string) =>
	defineCommand({
		name: 'text.echo',
		description: version,
		input: obj({ text: Type.String() }),
		execute({ text }) {
			return Result.ok(`${version}:${text}`)
		},
	})

describe('command registry', () => {
	it('uses fixed registration handles and dynamic name lookup', async () => {
		const registry = createCommandRegistry()
		const first = registry.register(command('one'))
		const firstResult = await first.execute({ text: 'x' })
		expect(firstResult.isOk()).toBe(true)
		const snapshot = registry.snapshot()
		expect(registry.snapshot()).toBe(snapshot)
		first[Symbol.dispose]()
		const withdrawnResult = await first.execute({ text: 'x' })
		expect(withdrawnResult.isErr()).toBe(true)
		const second = registry.register(command('two'))
		expect(first.descriptor.description).toBe('one')
		const staleResult = await first.execute({ text: 'x' })
		expect(staleResult.isErr()).toBe(true)
		const current = await registry.execute('text.echo', { text: 'x' })
		expect(current.isOk() && current.value).toBe('two:x')
		second.dispose()
		const missingResult = await registry.execute('text.echo', {})
		expect(missingResult.isErr()).toBe(true)
	})

	it('keeps the published execute function when the source object changes', async () => {
		const registry = createCommandRegistry()
		const mutable = {
			name: 'text.echo',
			descriptor: command('one').descriptor,
			async execute({ text }: { text: string }) {
				return Result.ok(`one:${text}`)
			},
		}
		using published = registry.register(mutable)
		mutable.execute = async ({ text }) => Result.ok(`changed:${text}`)
		const fixed = await published.execute({ text: 'x' })
		const dynamic = await registry.execute('text.echo', { text: 'x' })
		expect(fixed.isOk() && fixed.value).toBe('one:x')
		expect(dynamic.isOk() && dynamic.value).toBe('one:x')
	})

	it('preserves ordered reentrant notifications and isolates observer errors', () => {
		const registry = createCommandRegistry()
		const seen: number[] = []
		registry.subscribe((snapshot) => {
			seen.push(snapshot.revision)
			if (snapshot.revision === 1)
				registry.register(
					defineCommand({
						name: 'other',
						description: 'Other command.',
						input: obj({}),
						execute() {
							return Result.ok()
						},
					}),
				)
		})
		registry.subscribe(() => {
			throw new Error('observer')
		})
		const first = registry.register(command('one'))
		expect(seen).toEqual([1, 2])
		expect(registry.list().map((entry) => entry.name)).toEqual(['other', 'text.echo'])
		first.dispose()
	})
})

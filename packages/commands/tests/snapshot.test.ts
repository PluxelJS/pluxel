import { describe, expect, it } from 'vitest'
import {
	createCommandRegistry,
	defineCommand,
	Result,
	snapshotCommand,
	type Command,
} from '../src/index'
import { obj } from '../src/typebox'

const defined = () =>
	defineCommand({
		name: 'snapshot.read',
		description: 'Read a value.',
		input: obj({}),
		execute: () => Result.ok('defined'),
	})

describe('command snapshots', () => {
	it('captures a detached descriptor and execute method while preserving the receiver', async () => {
		const original = defined()
		const source = {
			name: original.name,
			descriptor: { ...original.descriptor, inputSchema: { type: 'object', properties: {} } },
			value: 'receiver',
			async execute() {
				return Result.ok(this.value)
			},
		}
		const captured = snapshotCommand(source)
		source.descriptor.description = 'changed'
		source.descriptor.inputSchema.type = 'string'
		source.execute = async () => Result.ok('replacement')
		expect(captured.descriptor.description).toBe(original.descriptor.description)
		expect(captured.descriptor.inputSchema.type).toBe('object')
		expect(Object.isFrozen(captured.descriptor.inputSchema)).toBe(true)
		const result = await captured.execute({})
		expect(result.unwrap()).toBe('receiver')
	})

	it('preserves publication withdrawal without giving the snapshot disposal ownership', async () => {
		const registry = createCommandRegistry()
		const published = registry.register(defined())
		const before = registry.snapshot()
		const captured = snapshotCommand(published)
		expect(registry.snapshot()).toBe(before)
		expect(captured).toHaveProperty('mounted', true)
		expect(captured).not.toHaveProperty('dispose')
		published.dispose()
		const result = await captured.execute({})
		expect(result.isErr()).toBe(true)
	})

	it.each([
		{ name: '' },
		{ execute: undefined },
		{ descriptor: { name: 'other', description: 'Other.', inputSchema: { type: 'object' } } },
		{ descriptor: { name: 'snapshot.read', description: '', inputSchema: { type: 'object' } } },
		{
			descriptor: { name: 'snapshot.read', description: 'Read.', inputSchema: { type: 'string' } },
		},
	])('rejects malformed command structure before publication: %j', (change) => {
		expect(() => snapshotCommand({ ...defined(), ...change } as unknown as Command)).toThrow(
			expect.objectContaining({ code: 'COMMAND_CONFIG' }),
		)
	})
})

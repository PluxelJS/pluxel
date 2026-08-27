import { describe, expect, it } from 'vitest'
import {
	createCommandRegistry,
	defineCommand,
	type CommandCatalogSnapshot,
	type CommandDescriptor,
	type InstalledCommand,
} from '../src'
import { Type, obj } from '../src/typebox'

const input = obj({ value: Type.Number() })
const output = obj({ value: Type.Number(), version: Type.String() })

function versionedCommand(version: string, presentation: 'first' | 'replacement' = 'first') {
	return defineCommand({
		name: 'math.versioned',
		title: presentation === 'first' ? 'First version' : 'Replacement version',
		description:
			presentation === 'first'
				? 'Run the first implementation.'
				: 'Run the replacement implementation.',
		behavior:
			presentation === 'first'
				? ({ kind: 'query', world: 'closed' } as const)
				: ({
						kind: 'mutation',
						destructive: false,
						idempotent: true,
						world: 'closed',
					} as const),
		input,
		output,
		examples: [{ input: { value: 1 }, output: { value: 1, version } }],
		execute: ({ value }) => ({ value, version }),
	})
}

describe('@pluxel/commands registry', () => {
	const assertDynamicLookupOutput = () => {
		const registry = createCommandRegistry()
		registry.register(versionedCommand('v1'))
		// @ts-expect-error A runtime name cannot recover one command's output type.
		const dynamicOutput: Promise<{ value: number; version: string }> = registry.execute(
			'math.versioned',
			{ value: 1 },
		)
		void dynamicOutput
	}
	void assertDynamicLookupOutput

	it('owns one immutable revisioned snapshot and notifies only later mutations', () => {
		const registry = createCommandRegistry()
		const initial = registry.snapshot()
		expect(initial).toEqual({ revision: 0, descriptors: [] })
		expect(Object.isFrozen(initial)).toBe(true)
		expect(Object.isFrozen(initial.descriptors)).toBe(true)
		expect(registry.snapshot()).toBe(initial)
		expect(registry.list()).toBe(initial.descriptors)

		const seen: CommandCatalogSnapshot[] = []
		const unsubscribe = registry.subscribe((snapshot) => seen.push(snapshot))
		expect(seen).toEqual([])

		const registration = registry.register(versionedCommand('v1'))
		expect(Object.isFrozen(registration)).toBe(true)
		const installed = registry.snapshot()
		expect(installed.revision).toBe(1)
		expect(installed).not.toBe(initial)
		expect(registry.snapshot()).toBe(installed)
		expect(registry.list()).toBe(installed.descriptors)
		expect(seen).toEqual([installed])

		registration.dispose()
		registration.dispose()
		const withdrawn = registry.snapshot()
		expect(withdrawn.revision).toBe(2)
		expect(seen).toEqual([installed, withdrawn])
		unsubscribe()
		unsubscribe()
		registry.register(versionedCommand('v2'))
		expect(seen).toEqual([installed, withdrawn])
	})

	it('returns a typed installed handle that follows compatible replacements', async () => {
		const registry = createCommandRegistry()
		const first = registry.register(versionedCommand('v1'))
		const typed: InstalledCommand<{ value: number }, { value: number; version: string }> = first
		await expect(typed.execute({ value: 1 })).resolves.toEqual({ value: 1, version: 'v1' })

		first.dispose()
		const replacement = versionedCommand('v2', 'replacement')
		const reordered = {
			...replacement,
			descriptor: reverseObjectKeys(replacement.descriptor) as CommandDescriptor,
		}
		const second = registry.register(reordered)

		await expect(first.execute({ value: 2 })).resolves.toEqual({ value: 2, version: 'v2' })
		expect(first.descriptor.title).toBe('Replacement version')
		expect(first.descriptor.behavior.kind).toBe('mutation')
		await expect(second.execute({ value: 3 })).resolves.toEqual({ value: 3, version: 'v2' })
	})

	it('fails a retained installed handle closed after withdrawal or an incompatible replacement', async () => {
		const registry = createCommandRegistry()
		const retained = registry.register(versionedCommand('v1'))
		retained.dispose()
		await expect(retained.execute({ value: 1 })).rejects.toMatchObject({
			code: 'COMMAND_NOT_FOUND',
		})

		const incompatible = defineCommand({
			name: 'math.versioned',
			description: 'Use an incompatible input schema.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({ value: Type.String() }),
			output,
			execute: ({ value }) => ({ value: Number(value), version: 'incompatible' }),
		})
		registry.register(incompatible)
		await expect(retained.execute({ value: 1 })).rejects.toMatchObject({
			code: 'COMMAND_NOT_FOUND',
		})
		await expect(registry.execute('math.versioned', { value: '2' })).resolves.toEqual({
			value: 2,
			version: 'incompatible',
		})
	})

	it('isolates subscriber failures from catalog mutation and other subscribers', () => {
		const registry = createCommandRegistry()
		const seen: number[] = []
		registry.subscribe(() => {
			throw new Error('listener failed')
		})
		registry.subscribe((snapshot) => seen.push(snapshot.revision))

		expect(() => registry.register(versionedCommand('v1'))).not.toThrow()
		expect(seen).toEqual([1])
	})

	it('queues reentrant catalog mutations so every listener sees monotonic revisions', () => {
		const registry = createCommandRegistry()
		const seen: string[] = []
		const late: number[] = []
		registry.subscribe((snapshot) => {
			seen.push(`first:${snapshot.revision}`)
			if (snapshot.revision !== 1) return
			registry.register(
				defineCommand({
					name: 'math.reentrant',
					description: 'Register from a catalog observer.',
					behavior: { kind: 'query', world: 'closed' },
					input: obj({}),
					execute() {},
				}),
			)
			registry.subscribe((current) => late.push(current.revision))
		})
		registry.subscribe((snapshot) => seen.push(`second:${snapshot.revision}`))

		registry.register(versionedCommand('v1'))

		expect(seen).toEqual(['first:1', 'second:1', 'first:2', 'second:2'])
		expect(late).toEqual([])
		registry.register(
			defineCommand({
				name: 'math.after-subscribe',
				description: 'Publish after the late subscription.',
				behavior: { kind: 'query', world: 'closed' },
				input: obj({}),
				execute() {},
			}),
		)
		expect(late).toEqual([3])
	})
})

function reverseObjectKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reverseObjectKeys)
	if (!value || typeof value !== 'object') return value
	const reversed: Record<string, unknown> = {}
	for (const [key, child] of Object.entries(value).toReversed()) {
		reversed[key] = reverseObjectKeys(child)
	}
	return reversed
}

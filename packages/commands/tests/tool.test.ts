import { describe, expect, it } from 'vitest'
import { createCommandRegistry, defineCommand } from '../src/index'
import { toToolDescriptor, toToolDescriptors } from '../src/tool'
import { Type, obj } from '../src/typebox'

const status = defineCommand({
	name: 'plugin.status.get',
	title: 'Plugin status',
	description: 'Read one plugin status.',
	behavior: { kind: 'query', world: 'closed' },
	input: obj({ name: Type.String({ description: 'Plugin name.' }) }),
	output: obj({ running: Type.Boolean() }),
	examples: [
		{ title: 'Runtime is running', input: { name: 'runtime' }, output: { running: true } },
	],
	execute: ({ name }) => ({ running: name === 'runtime' }),
})

describe('@pluxel/commands tool projection', () => {
	it('maps complete command semantics to common Agent/MCP tool facts', () => {
		expect(toToolDescriptor(status.descriptor)).toEqual({
			name: 'plugin.status.get',
			title: 'Plugin status',
			description: 'Read one plugin status.',
			inputSchema: expect.objectContaining({ type: 'object', additionalProperties: false }),
			outputSchema: expect.objectContaining({ type: 'object', additionalProperties: false }),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			execution: { taskSupport: 'forbidden' },
		})
		expect(toToolDescriptor(status.descriptor)).not.toHaveProperty('examples')
		expect(toToolDescriptor(status.descriptor).description).not.toContain('Runtime is running')
	})

	it('maps explicit mutation semantics without a lossy effect enum', () => {
		const stop = defineCommand({
			name: 'plugin.stop',
			description: 'Stop one plugin.',
			behavior: {
				kind: 'mutation',
				destructive: true,
				idempotent: true,
				world: 'closed',
			},
			input: obj({ name: Type.String() }),
			output: obj({ stopped: Type.Boolean() }),
			execute: () => ({ stopped: true }),
		})
		expect(toToolDescriptor(stop.descriptor).annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		})
	})

	it('omits outputSchema for commands whose Result value is void', () => {
		const clear = defineCommand({
			name: 'cache.clear',
			description: 'Clear one cache.',
			behavior: {
				kind: 'mutation',
				destructive: true,
				idempotent: true,
				world: 'closed',
			},
			input: obj({ name: Type.String() }),
			execute() {},
		})
		expect(toToolDescriptor(clear.descriptor)).not.toHaveProperty('outputSchema')
	})

	it('reuses the registry as the only catalog and caches pure projections', async () => {
		const registry = createCommandRegistry()
		registry.register(status)
		const descriptors = registry.list()
		const first = toToolDescriptors(descriptors)
		expect(toToolDescriptors(descriptors)).toBe(first)
		expect(toToolDescriptor(status.descriptor)).toBe(first[0])
		await expect(
			registry.executeOrThrow('plugin.status.get', { name: 'runtime' }),
		).resolves.toEqual({ running: true })
	})

	it('does not freeze or cache caller-owned mutable descriptor data', () => {
		const inputSchema = { type: 'object', properties: {} }
		const descriptor = {
			name: 'mutable.status',
			description: 'Initial description.',
			behavior: { kind: 'query', world: 'closed' } as const,
			inputSchema,
		}
		const descriptors = [descriptor]
		const first = toToolDescriptors(descriptors)

		expect(Object.isFrozen(descriptors)).toBe(false)
		expect(Object.isFrozen(inputSchema)).toBe(false)
		descriptor.description = 'Updated description.'
		descriptors.push({ ...descriptor, name: 'mutable.second' })
		const second = toToolDescriptors(descriptors)

		expect(second).not.toBe(first)
		expect(second).toHaveLength(2)
		expect(second[0]?.description).toBe('Updated description.')
	})

	it('does not treat a shallow-frozen descriptor as a stable snapshot', () => {
		const inputSchema = { type: 'object', properties: {} }
		const descriptor = Object.freeze({
			name: 'shallow.status',
			description: 'Shallow descriptor.',
			behavior: { kind: 'query', world: 'closed' } as const,
			inputSchema,
		})
		const first = toToolDescriptor(descriptor)
		inputSchema.properties = { changed: { type: 'boolean' } }
		const second = toToolDescriptor(descriptor)

		expect(Object.isFrozen(inputSchema)).toBe(false)
		expect(second).not.toBe(first)
		expect(second.inputSchema).toMatchObject({ properties: { changed: { type: 'boolean' } } })
	})
})

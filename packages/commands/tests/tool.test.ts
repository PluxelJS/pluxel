import { describe, expect, it } from 'vitest'
import { defineCommand } from '../src/index'
import { toToolDescriptor } from '../src/tool'
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

	it('rejects non-JSON schemas even when an external descriptor is deeply frozen', () => {
		const descriptor = Object.freeze({
			name: 'frozen.invalid',
			description: 'Invalid frozen descriptor.',
			behavior: Object.freeze({ kind: 'query', world: 'closed' } as const),
			inputSchema: Object.freeze({
				type: 'object',
				annotation: Object.freeze(new Date('2026-07-27T00:00:00.000Z')),
			}),
		})

		expect(() => toToolDescriptor(descriptor)).toThrow(/not valid JSON/)
	})
})

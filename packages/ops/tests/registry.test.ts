import { describe, expect, it } from 'vitest'
import { createRegistry, defineOp } from '@pluxel/ops'
import { Type, obj } from '@pluxel/ops/typebox'

const makeOp = (id: string) =>
	defineOp({
		id,
		doc: {
			title: id,
			description: `Operation ${id}.`,
		},
		input: obj({ value: Type.Optional(Type.Number({ default: 1 })) }),
		output: obj({ value: Type.Number() }),
		run(input) {
			return { value: input.value ?? 0 }
		},
	})

describe('@pluxel/ops registry v2', () => {
	it('registers, lists, gets, invokes, and disposes operations', async () => {
		const registry = createRegistry()
		const registration = registry.register(makeOp('demo.two'))
		registry.register(makeOp('demo.one'))

		expect(registry.get('demo.two')).toBeTruthy()
		expect(registry.get('demo.two')?.id).toBe('demo.two')
		expect(registry.list().map((descriptor) => descriptor.id)).toEqual(['demo.one', 'demo.two'])
		await expect(registry.invokeRaw('demo.two', {})).resolves.toEqual({ value: 1 })
		await expect(registry.invoke('demo.two', { value: 3 })).resolves.toEqual({
			ok: true,
			value: { value: 3 },
		})

		registration.dispose()
		expect(registry.get('demo.two')).toBeUndefined()
	})

	it('rejects duplicate ids', () => {
		const registry = createRegistry()
		registry.register(makeOp('demo.duplicate'))
		expect(() => registry.register(makeOp('demo.duplicate'))).toThrow(/already registered/)
	})

	it('returns safe not-found results and raw not-found throws', async () => {
		const registry = createRegistry()
		await expect(registry.invoke('missing.op', {})).resolves.toMatchObject({
			ok: false,
			error: { code: 'E_OP_NOT_FOUND' },
		})
		await expect(registry.invokeRaw('missing.op', {})).rejects.toMatchObject({
			code: 'E_OP_NOT_FOUND',
		})
	})
})

import { describe, expect, it } from 'vitest'
import { defineOp, errors, validation } from '@pluxel/ops'
import { Type, obj } from '@pluxel/ops/typebox'

describe('@pluxel/ops core v2', () => {
	it('creates a descriptor with only id, doc, and schemas', async () => {
		const op = defineOp({
			id: 'math.add',
			doc: {
				title: 'Add Numbers',
				description: 'Add one to the input number.',
			},
			input: obj({ value: Type.Number() }),
			output: obj({ total: Type.Number() }),
			run(input) {
				return { total: input.value + 1 }
			},
		})

		expect(op.descriptor).toEqual({
			id: 'math.add',
			doc: {
				title: 'Add Numbers',
				description: 'Add one to the input number.',
			},
			schemas: {
				input: expect.objectContaining({ type: 'object' }),
				output: expect.objectContaining({ type: 'object' }),
			},
		})
		expect(Object.keys(op.descriptor).sort()).toEqual(['doc', 'id', 'schemas'])
		await expect(op.invokeRaw({ value: 2 })).resolves.toEqual({ total: 3 })
	})

	it('normalizes input before validate and run', async () => {
		const seen: number[] = []
		const op = defineOp({
			id: 'math.defaulted',
			doc: {
				title: 'Default Number',
				description: 'Apply schema defaults before custom validation.',
			},
			input: obj({
				value: Type.Optional(Type.Number({ default: 4 })),
			}),
			output: obj({ value: Type.Number() }),
			validate(input) {
				seen.push(input.value ?? -1)
			},
			run(input) {
				return { value: input.value ?? 0 }
			},
		})

		await expect(op.invokeRaw({})).resolves.toEqual({ value: 4 })
		expect(seen).toEqual([4])
	})

	it('returns structured validation errors from safe invoke', async () => {
		const op = defineOp({
			id: 'math.positive',
			doc: {
				title: 'Positive Number',
				description: 'Require a positive number using custom validation.',
			},
			input: obj({ value: Type.Number() }),
			output: obj({ value: Type.Number() }),
			validate(input) {
				if (input.value <= 0) {
					return validation.issue('value must be positive', {
						path: ['value'],
						code: 'positive',
					})
				}
			},
			run(input) {
				return input
			},
		})

		const result = await op.invoke({ value: 0 })
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('expected input validation to fail')
		expect(result.error).toBeInstanceOf(errors.OpError)
		expect(result.error.code).toBe('E_INPUT_VALIDATION')
		expect(result.error.details).toEqual({
			issues: [{ message: 'value must be positive', path: ['value'], code: 'positive' }],
		})
	})

	it('runs output schema validation before validateOutput', async () => {
		const op = defineOp({
			id: 'math.output',
			doc: {
				title: 'Validate Output',
				description: 'Validate output shape and output constraints.',
			},
			input: obj({}),
			output: obj({ count: Type.Number() }),
			validateOutput(output) {
				if (output.count > 10) return validation.issue('count is too high', { path: ['count'] })
			},
			run() {
				return { count: 11 }
			},
		})

		await expect(op.invokeRaw({})).rejects.toMatchObject({
			code: 'E_OUTPUT_VALIDATION',
			details: { issues: [{ message: 'count is too high', path: ['count'] }] },
		})
	})
})

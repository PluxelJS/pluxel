import { Runtime } from '@sinclair/parsebox'
import { describe, expect, it } from 'vitest'
import { cli, defineOp, errors, validation } from '@pluxel/ops'
import { Type, obj } from '@pluxel/ops/typebox'

describe('@pluxel/ops core', () => {
	it('applies TypeBox defaults before execute', async () => {
		const op = defineOp({
			id: 'math.sum',
			input: obj({
				a: Type.Number(),
				b: Type.Optional(Type.Number({ default: 1 })),
			}),
			output: obj({
				total: Type.Number(),
			}),
			async execute(input) {
				return { total: input.a + input.b }
			},
		})

		await expect(op.run({ a: 2 })).resolves.toEqual({ total: 3 })
	})

	it('rejects unknown object keys by default', async () => {
		const op = defineOp({
			id: 'math.strict',
			input: obj({
				a: Type.Number(),
			}),
			output: obj({
				ok: Type.Boolean(),
			}),
			async execute() {
				return { ok: true }
			},
		})

		const result = await op.runSafe({ a: 1, extra: true })
		expect(result.ok).toBe(false)
		if (result.ok !== false) return
		expect(result.error.code).toBe('E_INPUT_VALIDATION')
	})

	it('preserves structured OpError instances', async () => {
		const op = defineOp({
			id: 'math.fail',
			input: obj({}),
			output: obj({}),
			async execute() {
				throw new errors.OpError('E_FORBIDDEN', 'Forbidden', {
					details: { node: 'plugin.config.write', reason: 'blocked' },
				})
			},
		})

		const result = await op.runSafe({})
		expect(result.ok).toBe(false)
		if (result.ok !== false) return
		expect(result.error.code).toBe('E_FORBIDDEN')
	})

	it('surfaces custom constraint validators as unified issues', async () => {
		const op = defineOp({
			id: 'math.constraint',
			input: obj({
				value: Type.Number(),
			}),
			output: obj({
				ok: Type.Boolean(),
			}),
			validateInput: [
				(input): void | ReturnType<typeof validation.constraint> => {
					if (input.value >= 0) return
					return validation.constraint('value', 'Expected a non-negative number', {
						code: 'non_negative',
					})
				},
			],
			async execute() {
				return { ok: true }
			},
		})

		const result = await op.runSafe({ value: -1 })
		expect(result.ok).toBe(false)
		if (result.ok !== false) return
		expect(result.error.code).toBe('E_INPUT_VALIDATION')
		expect(result.error.details).toEqual({
			issues: [
				{
					path: ['value'],
					message: 'Expected a non-negative number',
					code: 'non_negative',
				},
			],
		})
	})

	it('rejects tool-visible ops without explicit doc guidance', () => {
		expect(() =>
			defineOp({
				id: 'plugin.status.get',
				doc: {
					title: 'Get Plugin Status',
				},
				input: obj({
					name: Type.String(),
				}),
				output: obj({
					ok: Type.Boolean(),
				}),
				tool: {
					name: 'plugin.status.get',
				},
				async execute() {
					return { ok: true }
				},
			}),
		).toThrow(/must define doc.description/i)
	})

	it('rejects invalid tool names at definition time', () => {
		expect(() =>
			defineOp({
				id: 'plugin.status.get',
				doc: {
					title: 'Get Plugin Status',
					description: 'Read one plugin status snapshot.',
				},
				input: obj({
					name: Type.String(),
				}),
				output: obj({
					ok: Type.Boolean(),
				}),
				tool: {
					name: 'Plugin Status',
				},
				async execute() {
					return { ok: true }
				},
			}),
		).toThrow(/tool.name/i)
	})

	it('rejects invalid op ids at definition time', () => {
		expect(() =>
			defineOp({
				id: 'Plugin Status',
				input: obj({}),
				output: obj({
					ok: Type.Boolean(),
				}),
				async execute() {
					return { ok: true }
				},
			}),
		).toThrow(/Operation id/i)
	})

	it('rejects tool-visible inputs without field descriptions', () => {
		expect(() =>
			defineOp({
				id: 'plugin.status.get',
				doc: {
					title: 'Get Plugin Status',
					description: 'Read one plugin status snapshot.',
				},
				input: obj({
					name: Type.String(),
				}),
				output: obj({
					ok: Type.Boolean(),
				}),
				tool: {
					name: 'plugin.status.get',
				},
				async execute() {
					return { ok: true }
				},
			}),
		).toThrow(/must describe input "name"/i)
	})

	it('rejects tool-visible nested inputs without field descriptions', () => {
		expect(() =>
			defineOp({
				id: 'plugin.status.patch',
				doc: {
					title: 'Patch Plugin Status',
					description: 'Patch a nested plugin status shape.',
				},
				input: obj({
					name: Type.String({ description: 'Plugin name.' }),
					status: obj(
						{
							stage: Type.String(),
						},
						{ description: 'Nested status patch.' },
					),
				}),
				output: obj({
					ok: Type.Boolean(),
				}),
				tool: true,
				async execute() {
					return { ok: true }
				},
			}),
		).toThrow(/must describe input "status\.stage"/i)
	})

	it('rejects internal ops that also declare external carriers', () => {
		expect(() =>
			defineOp({
				id: 'internal.echo',
				input: obj({}),
				output: obj({
					ok: Type.Boolean(),
				}),
				exposure: {
					internal: true,
					rpc: true,
				},
				async execute() {
					return { ok: true }
				},
			}),
		).toThrow(/cannot declare rpc, cli, or tool exposure/i)
	})

	it('rejects invalid CLI trigger tokens at definition time', () => {
		expect(() =>
			defineOp({
				id: 'plugin.status.get',
				input: obj({}),
				output: obj({
					ok: Type.Boolean(),
				}),
				cli: {
					triggers: ['Plugin Status'],
				},
				async execute() {
					return { ok: true }
				},
			}),
		).toThrow(/CLI trigger/i)
	})

	it('projects parsebox CLI metadata into the canonical descriptor without parser state', () => {
		const module = new Runtime.Module({
			Main: Runtime.String(['"']),
		})
		const op = defineOp({
			id: 'math.parsebox',
			doc: {
				title: 'ParseBox Example',
				description: 'Example parsebox op.',
			},
			input: obj({
				value: Type.String({ description: 'Value.' }),
			}),
			output: obj({
				ok: Type.Boolean(),
			}),
			cli: {
				triggers: ['math parsebox'],
				tail: cli.tail.parsebox(module, 'Main', {
					placeholder: '<value>',
					keys: ['value'],
				}),
			},
			async execute() {
				return { ok: true }
			},
		})

		expect(op.descriptor).toEqual(
			expect.objectContaining({
				transports: expect.objectContaining({
					cli: expect.objectContaining({
						tail: {
							mode: 'parsebox',
							entry: 'Main',
							placeholder: '<value>',
							keys: ['value'],
						},
					}),
				}),
			}),
		)
	})
})

import { describe, expect, it } from 'vitest'
import { cli, defineOp, errors, toPublicDescriptor, typebox, validation } from '../src/index.ts'

describe('@pluxel/ops core', () => {
	it('applies TypeBox defaults before execute', async () => {
		const op = defineOp({
			id: 'math.sum',
			input: typebox.obj({
				a: typebox.Type.Number(),
				b: typebox.Type.Optional(typebox.Type.Number({ default: 1 })),
			}),
			output: typebox.obj({
				total: typebox.Type.Number(),
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
			input: typebox.obj({
				a: typebox.Type.Number(),
			}),
			output: typebox.obj({
				ok: typebox.Type.Boolean(),
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

	it('allows error recovery through phase interceptors', async () => {
		const op = defineOp({
			id: 'math.recover',
			input: typebox.obj({
				value: typebox.Type.Number(),
			}),
			output: typebox.obj({
				value: typebox.Type.Number(),
			}),
			interceptors: [
				{
					canRecover: true,
					onError() {
						return { kind: 'recover', outputCandidate: { value: 0 } }
					},
				},
			],
			async execute() {
				throw new Error('boom')
			},
		})

		await expect(op.run({ value: 1 })).resolves.toEqual({ value: 0 })
	})

	it('preserves structured OpError instances', async () => {
		const op = defineOp({
			id: 'math.fail',
			input: typebox.obj({}),
			output: typebox.obj({}),
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
			input: typebox.obj({
				value: typebox.Type.Number(),
			}),
			output: typebox.obj({
				ok: typebox.Type.Boolean(),
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
				input: typebox.obj({
					name: typebox.Type.String(),
				}),
				output: typebox.obj({
					ok: typebox.Type.Boolean(),
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
				input: typebox.obj({
					name: typebox.Type.String(),
				}),
				output: typebox.obj({
					ok: typebox.Type.Boolean(),
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

	it('rejects tool-visible inputs without field descriptions', () => {
		expect(() =>
			defineOp({
				id: 'plugin.status.get',
				doc: {
					title: 'Get Plugin Status',
					description: 'Read one plugin status snapshot.',
				},
				input: typebox.obj({
					name: typebox.Type.String(),
				}),
				output: typebox.obj({
					ok: typebox.Type.Boolean(),
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

	it('rejects internal ops that also declare external carriers', () => {
		expect(() =>
			defineOp({
				id: 'internal.echo',
				input: typebox.obj({}),
				output: typebox.obj({
					ok: typebox.Type.Boolean(),
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

	it('projects parsebox CLI metadata into a serializable public descriptor', () => {
		const op = defineOp({
			id: 'math.parsebox',
			doc: {
				title: 'ParseBox Example',
				description: 'Example parsebox op.',
			},
			input: typebox.obj({
				value: typebox.Type.String({ description: 'Value.' }),
			}),
			output: typebox.obj({
				ok: typebox.Type.Boolean(),
			}),
			cli: {
				triggers: ['math parsebox'],
				tail: cli.tail.parsebox({} as any, 'Main' as any, {
					placeholder: '<value>',
					keys: ['value'],
				}),
			},
			async execute() {
				return { ok: true }
			},
		})

		expect(toPublicDescriptor(op.descriptor)).toEqual(
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

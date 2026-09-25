import { describe, expect, it } from 'vitest'
import { defineCommand, Result, type CommandContext } from '../src/index'
import { Type, obj } from '../src/typebox'

describe('command execution', () => {
	it('uses four fields, validates wire input, and keeps one Result layer', async () => {
		const config = {
			name: 'text.echo',
			description: 'Return the text.',
			input: obj({ text: Type.String() }),
			execute: ({ text }: { text: string }) => Result.ok(text),
		}
		const command = defineCommand(config)
		config.description = 'Changed later.'
		expect(command.descriptor.description).toBe('Return the text.')
		expect(Object.isFrozen(command.descriptor)).toBe(true)
		const output = await command.execute({ text: 'hi' })
		expect(output.isOk() && output.value).toBe('hi')
		const invalid = await command.execute({ text: 42 } as never)
		expect(invalid.isErr() && invalid.error.code).toBe('INPUT_VALIDATION')
		// @ts-expect-error A known command accepts only its wire input.
		void command.execute({ tetx: 42 })
	})

	it('decodes once, fills defaults, and does not require an output schema', async () => {
		let count = 0
		const numericInput = Type.Transform(Type.String())
			.Decode((value) => {
				count++
				return Number(value)
			})
			.Encode(String)
		const command = defineCommand({
			name: 'number.double',
			description: 'Double the number.',
			input: obj({ number: numericInput, scale: Type.Optional(Type.Number({ default: 2 })) }),
			execute({ number, scale }) {
				return Result.ok(number * (scale ?? 1))
			},
		})
		const output = await command.execute({ number: '3' })
		expect(output.isOk() && output.value).toBe(6)
		expect(count).toBe(1)
	})

	it('keeps codec diagnostics local when decoding fails', async () => {
		const secret = 'private parser detail'
		const command = defineCommand({
			name: 'parse.safe',
			description: 'Parse input.',
			input: obj({
				value: Type.Transform(Type.String())
					.Decode(() => {
						throw new Error(secret)
					})
					.Encode(String),
			}),
			execute() {
				return Result.ok()
			},
		})
		const result = await command.execute({ value: 'invalid' })
		expect(result.isErr()).toBe(true)
		if (result.isOk()) return
		expect(result.error).toMatchObject({
			code: 'INPUT_VALIDATION',
			issues: [{ code: 'codec_decode', message: 'Input could not be decoded' }],
		})
		expect(result.error.message).not.toContain(secret)
	})

	it('classifies invalid trusted context before execution', async () => {
		const command = defineCommand({
			name: 'context.safe',
			description: 'Read context.',
			input: obj({}),
			execute() {
				return Result.ok('called')
			},
		})
		const context = Object.defineProperty({}, 'signal', {
			get() {
				throw new Error('broken context')
			},
		}) as CommandContext
		const result = await command.execute({}, context)
		expect(result.isErr() && result.error).toMatchObject({ code: 'INTERNAL' })
	})

	it('preserves business errors and valid results that finish after cancellation', async () => {
		const controller = new AbortController()
		const command = defineCommand({
			name: 'receipt.issue',
			description: 'Return a receipt.',
			input: obj({}),
			async execute(_input, context) {
				await new Promise((resolve) => setTimeout(resolve, 5))
				controller.abort()
				expect(context.signal?.aborted).toBe(true)
				return Result.ok({ receipt: 'committed' })
			},
		})
		const result = await command.execute({}, { signal: controller.signal })
		expect(result.isOk() && result.value).toEqual({ receipt: 'committed' })
		const rejected = defineCommand({
			name: 'receipt.reject',
			description: 'Reject a request.',
			input: obj({}),
			execute() {
				return Result.err({ code: 'REJECTED' as const, reason: 'closed', message: 'Closed' })
			},
		})
		const failure = await rejected.execute({})
		expect(failure.isErr() && failure.error).toMatchObject({ code: 'REJECTED', reason: 'closed' })
	})

	it('classifies faults, invalid Results, and cancellation without hiding unrelated errors', async () => {
		const broken = defineCommand({
			name: 'broken',
			description: 'Throw an error.',
			input: obj({}),
			execute() {
				throw new Error('boom')
			},
		})
		const fault = await broken.execute({})
		expect(fault.isErr() && fault.error).toMatchObject({
			code: 'INTERNAL',
			cause: expect.any(Error),
		})
		const invalid = defineCommand({
			name: 'invalid',
			description: 'Return invalid data.',
			input: obj({}),
			execute() {
				return 1 as never
			},
		})
		const invalidResult = await invalid.execute({})
		expect(invalidResult.isErr()).toBe(true)
		const contradictory = defineCommand({
			name: 'contradictory',
			description: 'Return a contradictory Result shape.',
			input: obj({}),
			execute() {
				return { status: 'ok', value: 'value', isOk: () => false, isErr: () => true } as never
			},
		})
		const contradictoryResult = await contradictory.execute({})
		expect(contradictoryResult.isErr() && contradictoryResult.error.code).toBe('INTERNAL')
		const cancelled = await broken.execute({}, { signal: AbortSignal.abort() })
		expect(cancelled.isErr() && cancelled.error.code).toBe('ABORTED')
		const timedOut = await broken.execute({}, { deadlineMs: Date.now() - 1 })
		expect(timedOut.isErr() && timedOut.error.code).toBe('TIMEOUT')
	})

	it('passes timeout through the handler signal and waits for cleanup', async () => {
		let cleaned = false
		const command = defineCommand({
			name: 'wait.deadline',
			description: 'Wait until cancelled.',
			input: obj({}),
			async execute(_input, context) {
				await new Promise<void>((resolve) =>
					context.signal!.addEventListener('abort', () => resolve(), { once: true }),
				)
				cleaned = true
				throw context.signal!.reason
			},
		})
		const result = await command.execute({}, { deadlineMs: Date.now() + 5 })
		expect(cleaned).toBe(true)
		expect(result.isErr() && result.error.code).toBe('TIMEOUT')
	})

	it('retains a framework deadline through an intermediate signal composition', async () => {
		const inner = defineCommand({
			name: 'wait.innerDeadline',
			description: 'Wait for the inherited deadline.',
			input: obj({}),
			async execute(_input, context) {
				await new Promise<void>((resolve) =>
					context.signal!.addEventListener('abort', () => resolve(), { once: true }),
				)
				throw context.signal!.reason
			},
		})
		const outer = defineCommand({
			name: 'wait.outerDeadline',
			description: 'Pass a composed signal to another Command.',
			input: obj({}),
			execute(_input, context) {
				const bridge = AbortSignal.any([context.signal!, new AbortController().signal])
				return inner.execute({}, { signal: bridge })
			},
		})
		const result = await outer.execute({}, { deadlineMs: Date.now() + 5 })
		expect(result.isErr() && result.error.code).toBe('TIMEOUT')
		const callerAbort = await inner.execute(
			{},
			{ signal: AbortSignal.any([AbortSignal.abort(new Error('Command deadline reached'))]) },
		)
		expect(callerAbort.isErr() && callerAbort.error.code).toBe('ABORTED')
	})

	it('does not fire a distant absolute deadline early', async () => {
		const command = defineCommand({
			name: 'wait.distantDeadline',
			description: 'Observe a distant deadline.',
			input: obj({}),
			async execute(_input, context) {
				await new Promise((resolve) => setTimeout(resolve, 10))
				return Result.ok(context.signal?.aborted)
			},
		})
		const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
		const result = await command.execute({}, { deadlineMs: Date.now() + thirtyDaysMs })
		expect(result.isOk() && result.value).toBe(false)
	})

	it('rejects malformed business failures as internal faults', async () => {
		const command = defineCommand({
			name: 'failure.invalid',
			description: 'Return a malformed failure.',
			input: obj({}),
			execute() {
				return Result.err({ code: 'REJECTED', message: 'Missing reason' } as never)
			},
		})
		const result = await command.execute({})
		expect(result.isErr() && result.error.code).toBe('INTERNAL')
	})

	it('checks input examples at definition without decoding them', () => {
		let decoded = 0
		const text = Type.Transform(Type.String())
			.Decode((value) => {
				decoded++
				return value
			})
			.Encode(String)
		expect(() =>
			defineCommand({
				name: 'example.valid',
				description: 'Validate an example.',
				input: obj({ text }, { examples: [{ text: 'hello' }] }),
				execute() {
					return Result.ok()
				},
			}),
		).not.toThrow()
		expect(decoded).toBe(0)
		expect(() =>
			defineCommand({
				name: 'example.invalid',
				description: 'Reject an invalid example.',
				input: obj({ text }, { examples: [{ text: 42 }] }),
				execute() {
					return Result.ok()
				},
			}),
		).toThrow('example')
	})

	it('requires context when a command declares additional fields', async () => {
		interface NoteContext extends CommandContext {
			actorId: string
		}
		const command = defineCommand({
			name: 'note.read',
			description: 'Read a note.',
			input: obj({ id: Type.String() }),
			execute({ id }, context: NoteContext) {
				return Result.ok(`${context.actorId}:${id}`)
			},
		})
		// @ts-expect-error NoteContext is required.
		void command.execute({ id: 'x' })
		const result = await command.execute({ id: 'x' }, { actorId: 'alice' })
		expect(result.isOk() && result.value).toBe('alice:x')
	})
})

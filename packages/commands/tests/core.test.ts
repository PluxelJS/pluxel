import { describe, expect, expectTypeOf, it } from 'vitest'
import { Type as JavaScriptType } from '@sinclair/typebox'
import * as corePublic from '../src/index'
import {
	CommandError,
	createCommandRegistry,
	defineCommand,
	validation,
	type CommandContext,
	type ValidationIssue,
} from '../src/index'
import { compileSchema } from '../src/schema'
import { Type, obj, openObj } from '../src/typebox'

function incrementCommand() {
	return defineCommand({
		name: 'math.increment',
		title: 'Increment',
		description: 'Increment a number.',
		behavior: { kind: 'query', world: 'closed' },
		input: obj({ value: Type.Number() }),
		output: obj({ value: Type.Number() }),
		execute(input) {
			return { value: input.value + 1 }
		},
	})
}

const assertCommandContextVariance = () => {
	type HostContext = CommandContext & { tenant: string }
	const input = obj({})
	const output = obj({ tenant: Type.String() })
	const hosted = defineCommand<typeof input, typeof output, HostContext>({
		name: 'context.variance',
		description: 'Keep required host context on every dispatch path.',
		behavior: { kind: 'query', world: 'closed' },
		input,
		output,
		execute: (_input, context) => ({ tenant: context.tenant }),
	})

	const baseRegistry = createCommandRegistry()
	// @ts-expect-error A base registry cannot safely invoke a command that requires HostContext.
	baseRegistry.register(hosted)

	const hostRegistry = createCommandRegistry<HostContext>()
	hostRegistry.register(hosted)
	// @ts-expect-error A registry with required host context must receive it for every invocation.
	void hostRegistry.execute('context.variance', {})
}
void assertCommandContextVariance

describe('@pluxel/commands core', () => {
	it('exposes one factory construction path at runtime', () => {
		expect(corePublic).toHaveProperty('createCommandRegistry')
		expect(corePublic).not.toHaveProperty('CommandRegistry')
	})

	it('compiles a flat JSON descriptor and keeps the typed handler private', async () => {
		const behavior = { kind: 'query', world: 'closed' } as const
		const command = defineCommand({
			name: 'math.increment',
			title: 'Increment',
			description: 'Increment a number.',
			behavior,
			input: obj({ value: Type.Number() }),
			output: obj({ value: Type.Number() }),
			execute: ({ value }) => ({ value: value + 1 }),
		})
		expect(command.descriptor).toEqual({
			name: 'math.increment',
			title: 'Increment',
			description: 'Increment a number.',
			behavior: { kind: 'query', world: 'closed' },
			inputSchema: expect.objectContaining({ type: 'object', additionalProperties: false }),
			outputSchema: expect.objectContaining({ type: 'object', additionalProperties: false }),
		})
		expect(Object.getOwnPropertySymbols(command.descriptor.inputSchema)).toEqual([])
		expect(command.descriptor.behavior).not.toBe(behavior)
		expect(Object.isFrozen(behavior)).toBe(false)
		expect(Object.isFrozen(command.descriptor.behavior)).toBe(true)
		expect(JSON.parse(JSON.stringify(command.descriptor))).toEqual(command.descriptor)
		await expect(command.executeOrThrow({ value: 2 })).resolves.toEqual({ value: 3 })
	})

	it('compiles schema projection and runtime validation into one cached artifact', async () => {
		const schema = obj({ value: Type.Integer({ default: 4 }) })
		const compiled = compileSchema(schema)

		expect(compileSchema(schema)).toBe(compiled)
		expect(Object.isFrozen(compiled)).toBe(true)
		expect(Object.isFrozen(compiled.jsonSchema)).toBe(true)
		expect(compiled.validateInput({})).toEqual({ ok: true, value: { value: 4 } })
		expect(compiled.validateOutput({})).toMatchObject({ ok: false })

		const command = defineCommand({
			name: 'schema.compiled.once',
			description: 'Reuse one compiled schema artifact.',
			behavior: { kind: 'query', world: 'closed' },
			input: schema,
			output: schema,
			execute: ({ value }) => ({ value }),
		})
		expect(command.descriptor.inputSchema).toBe(compiled.jsonSchema)
		expect(command.descriptor.outputSchema).toBe(compiled.jsonSchema)
		await expect(command.executeOrThrow({})).resolves.toEqual({ value: 4 })
	})

	it('captures the implementation without freezing the public command handle', async () => {
		const input = obj({})
		const output = obj({ value: Type.Number() })
		const config = {
			name: 'snapshot.implementation',
			description: 'Capture one implementation.',
			behavior: { kind: 'query', world: 'closed' } as const,
			input,
			output,
			execute: () => ({ value: 1 }),
		}
		const command = defineCommand(config)
		config.execute = () => ({ value: 2 })

		expect(Object.isFrozen(command)).toBe(false)
		await expect(command.executeOrThrow({})).resolves.toEqual({ value: 1 })
	})

	it('requires context only when a host adds required context fields', async () => {
		type HostContext = CommandContext & { tenant: string }
		const input = obj({})
		const output = obj({ tenant: Type.String() })
		const command = defineCommand<typeof input, typeof output, HostContext>({
			name: 'context.required',
			description: 'Read required host context.',
			behavior: { kind: 'query', world: 'closed' },
			input,
			output,
			execute(_input, context) {
				return { tenant: context.tenant }
			},
		})

		expectTypeOf(command.executeOrThrow).parameters.toEqualTypeOf<[unknown, HostContext]>()
		await expect(command.executeOrThrow({}, { tenant: 'acme' })).resolves.toEqual({
			tenant: 'acme',
		})
	})

	it('applies defaults before custom validation and validates output', async () => {
		const seen: number[] = []
		const command = defineCommand({
			name: 'math.defaulted',
			description: 'Apply a default.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({ value: Type.Optional(Type.Number({ default: 4 })) }),
			output: obj({ value: Type.Number() }),
			validate(input) {
				seen.push(input.value!)
			},
			execute(input) {
				return { value: input.value! }
			},
		})
		await expect(command.executeOrThrow({})).resolves.toEqual({ value: 4 })
		expect(seen).toEqual([4])
	})

	it('normalizes structured examples into the frozen JSON descriptor', () => {
		const command = defineCommand({
			name: 'math.defaulted.example',
			description: 'Show a normalized example.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({ value: Type.Optional(Type.Number({ default: 4 })) }),
			output: obj({ value: Type.Number() }),
			examples: [{ title: '  Default value  ', input: {}, output: { value: 4 } }],
			execute: ({ value }) => ({ value: value! }),
		})

		expect(command.descriptor.examples).toEqual([
			{ title: 'Default value', input: { value: 4 }, output: { value: 4 } },
		])
		expect(Object.isFrozen(command.descriptor.examples)).toBe(true)
		expect(JSON.parse(JSON.stringify(command.descriptor))).toEqual(command.descriptor)
	})

	it('uses CommandResult<void> when no structured output is declared', async () => {
		const seen: string[] = []
		const command = defineCommand({
			name: 'cache.clear',
			description: 'Clear one cache.',
			behavior: {
				kind: 'mutation',
				destructive: true,
				idempotent: true,
				world: 'closed',
			},
			input: obj({ name: Type.String() }),
			examples: [{ input: { name: 'build' } }],
			execute: ({ name }) => {
				seen.push(name)
			},
		})

		expect(command.descriptor).not.toHaveProperty('outputSchema')
		await expect(command.executeOrThrow({ name: 'build' })).resolves.toBeUndefined()
		await expect(command.execute({ name: 'assets' })).resolves.toEqual({
			ok: true,
			value: undefined,
		})
		expect(seen).toEqual(['build', 'assets'])
	})

	it('rejects an undeclared handler output instead of silently discarding it', async () => {
		const command = defineCommand({
			name: 'cache.clear.invalid',
			description: 'Return an undeclared value.',
			behavior: {
				kind: 'mutation',
				destructive: true,
				idempotent: true,
				world: 'closed',
			},
			input: obj({}),
			execute: () => ({ cleared: true }),
		} as never)

		await expect(command.executeOrThrow({})).rejects.toMatchObject({
			code: 'OUTPUT_VALIDATION',
			details: { issues: [{ code: 'unexpected_output' }] },
		})
	})

	it('rejects schema-invalid and non-JSON command examples', () => {
		const base = {
			name: 'math.example.invalid',
			description: 'Reject invalid examples.',
			behavior: { kind: 'query', world: 'closed' } as const,
			input: obj({ value: Type.Number() }),
			output: obj({ value: Type.Number() }),
			execute: ({ value }: { value: number }) => ({ value }),
		}

		expect(() =>
			defineCommand({ ...base, examples: [{ input: { value: 'no' } }] } as never),
		).toThrow(/example 1 has invalid input/)
		expect(() =>
			defineCommand({
				...base,
				examples: [{ input: { value: 1 }, output: { value: 'no' } }],
			} as never),
		).toThrow(/example 1 has invalid output/)

		expect(() =>
			defineCommand({
				...base,
				input: obj({ value: Type.Any() }),
				examples: [{ input: { value: 1n } }],
			}),
		).toThrow(/not valid JSON: bigint/)
	})

	it('applies defaults to input but never fills missing handler output', async () => {
		const command = defineCommand({
			name: 'defaults.direction',
			description: 'Keep default direction explicit.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({ inputValue: Type.Optional(Type.Number({ default: 4 })) }),
			output: obj({ outputValue: Type.Optional(Type.Number({ default: 8 })) }),
			examples: [{ input: {}, output: {} }],
			execute(input) {
				expect(input.inputValue).toBe(4)
				return {}
			},
		})

		await expect(command.executeOrThrow({})).resolves.toEqual({})
		expect(command.descriptor.examples).toEqual([{ input: { inputValue: 4 }, output: {} }])
	})

	it('rejects non-JSON wire values even when the schema accepts anything', async () => {
		const inputCommand = defineCommand({
			name: 'json.input.only',
			description: 'Accept one JSON value.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({ value: Type.Any() }),
			output: obj({ accepted: Type.Boolean() }),
			execute: () => ({ accepted: true }),
		})
		await expect(inputCommand.executeOrThrow({ value: () => true })).rejects.toMatchObject({
			code: 'INPUT_VALIDATION',
			details: { issues: [{ path: ['value'], code: 'non_json_value' }] },
		})

		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		await expect(inputCommand.executeOrThrow({ value: cyclic })).rejects.toMatchObject({
			code: 'INPUT_VALIDATION',
			details: { issues: [{ code: 'non_json_value' }] },
		})

		const outputCommand = defineCommand({
			name: 'json.output.only',
			description: 'Return one JSON value.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({}),
			output: obj({ value: Type.Any() }),
			execute: () => ({ value: 1n }),
		})
		await expect(outputCommand.executeOrThrow({})).rejects.toMatchObject({
			code: 'OUTPUT_VALIDATION',
			kind: 'fault',
			details: { issues: [{ path: ['value'], code: 'non_json_value' }] },
		})
	})

	it('rejects non-JSON defaults and annotations in the published schema', () => {
		expect(() =>
			defineCommand({
				name: 'schema.invalid.default',
				description: 'Reject an invalid schema default.',
				behavior: { kind: 'query', world: 'closed' },
				input: obj({ value: Type.Optional(Type.Any({ default: 1n })) }),
				execute() {},
			}),
		).toThrow(/input must be a portable JSON Schema/)
	})

	it('rejects schema-invalid defaults when the command is defined', () => {
		let failure: unknown
		try {
			defineCommand({
				name: 'schema.mismatched.default',
				description: 'Reject a default that does not satisfy its field schema.',
				behavior: { kind: 'query', world: 'closed' },
				input: obj({ value: Type.Optional(Type.Integer({ default: 'four' })) }),
				execute() {},
			})
		} catch (error) {
			failure = error
		}
		expect(failure).toMatchObject({
			code: 'COMMAND_CONFIG',
			kind: 'fault',
			details: {
				command: 'schema.mismatched.default',
				field: 'input',
				reason: 'invalid_default',
				path: ['properties', 'value'],
			},
		})
		expect(failure).toHaveProperty(
			'message',
			expect.stringContaining('default at $.properties.value does not satisfy its schema'),
		)
	})

	it('returns stable structured validation failures', async () => {
		const command = defineCommand({
			name: 'math.positive',
			description: 'Require a positive number.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({ value: Type.Number() }),
			output: obj({ value: Type.Number() }),
			validate(input) {
				if (input.value <= 0) {
					return validation.constraint('value', 'Must be positive', { code: 'positive' })
				}
				return undefined
			},
			execute(input) {
				return input
			},
		})
		const result = await command.execute({ value: 0 })
		expect(result).toMatchObject({
			ok: false,
			error: {
				code: 'INPUT_VALIDATION',
				details: { issues: [{ path: ['value'], message: 'Must be positive', code: 'positive' }] },
			},
		})
		if (result.ok !== false) throw new Error('expected validation failure')
		expect(result.error).toBeInstanceOf(CommandError)
		expect(result.error.kind).toBe('expected')
	})

	it('does not expose TypeBox numeric error identifiers as command error codes', async () => {
		const result = await incrementCommand().execute({})
		expect(result).toMatchObject({ ok: false, error: { code: 'INPUT_VALIDATION' } })
		if (result.ok !== false) throw new Error('expected validation failure')
		const details = result.error.details
		if (!details || !('issues' in details)) throw new Error('expected validation issues')
		if (!Array.isArray(details.issues)) throw new Error('expected validation issue array')
		const issues = details.issues as ValidationIssue[]
		expect(issues.length).toBeGreaterThan(0)
		expect(issues.every((current) => current.code === 'schema_validation')).toBe(true)
		expect(issues).toContainEqual(expect.objectContaining({ path: ['value'] }))
	})

	it('classifies configuration and invalid handler output as faults', async () => {
		const command = defineCommand({
			name: 'math.invalid.output',
			description: 'Return invalid output.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({}),
			output: obj({ value: Type.Number() }),
			execute: () => ({ value: 'invalid' }) as never,
		})
		const result = await command.execute({})
		expect(result).toMatchObject({
			ok: false,
			error: { code: 'OUTPUT_VALIDATION', kind: 'fault', publicMessage: 'Command failed' },
		})
	})

	it('requires explicit complete mutation behavior', () => {
		expect(() =>
			defineCommand({
				name: 'plugin.stop',
				description: 'Stop a plugin.',
				behavior: { kind: 'mutation', world: 'closed' } as never,
				input: obj({ name: Type.String() }),
				output: obj({ stopped: Type.Boolean() }),
				execute: () => ({ stopped: true }),
			}),
		).toThrow(/destructive and idempotent/)
	})

	it('rejects non-string command names at the runtime configuration boundary', () => {
		let failure: unknown
		try {
			defineCommand({
				name: new String('boxed.name'),
				description: 'Reject a boxed command name.',
				behavior: { kind: 'query', world: 'closed' },
				input: obj({}),
				execute() {},
			} as never)
		} catch (error) {
			failure = error
		}
		expect(failure).toMatchObject({
			code: 'COMMAND_CONFIG',
			details: { field: 'name' },
		})
	})

	it('rejects non-object schemas at runtime as well as at the type boundary', () => {
		expect(() =>
			defineCommand({
				name: 'echo.text',
				description: 'Echo text.',
				behavior: { kind: 'query', world: 'closed' },
				input: Type.String(),
				output: obj({ text: Type.String() }),
				execute: (input: string) => ({ text: input }),
			} as never),
		).toThrow(/input must be an object schema/)
	})

	it('closes nested objects by default and keeps open objects explicit', async () => {
		const command = defineCommand({
			name: 'object.boundaries',
			description: 'Keep object extension boundaries explicit.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({
				closed: Type.Object({ known: Type.String() }),
				open: openObj({ known: Type.String() }),
			}),
			execute() {},
		})

		expect(command.descriptor.inputSchema).toMatchObject({
			properties: {
				closed: { additionalProperties: false },
				open: { additionalProperties: true },
			},
		})
		await expect(
			command.executeOrThrow({
				closed: { known: 'value' },
				open: { known: 'value', extension: true },
			}),
		).resolves.toBeUndefined()
		await expect(
			command.executeOrThrow({
				closed: { known: 'value', extension: true },
				open: { known: 'value' },
			}),
		).rejects.toMatchObject({ code: 'INPUT_VALIDATION' })
	})

	it('rejects JavaScript value schemas that cannot cross a JSON tool boundary', () => {
		expect(() =>
			defineCommand({
				name: 'date.read',
				description: 'Read a date.',
				behavior: { kind: 'query', world: 'closed' },
				input: obj({ value: JavaScriptType.Date() }),
				output: obj({ value: Type.String() }),
				execute: () => ({ value: 'never' }),
			}),
		).toThrow(/input must be a portable JSON Schema/)
		expect(() =>
			defineCommand({
				name: 'bigint.read',
				description: 'Read a big integer.',
				behavior: { kind: 'query', world: 'closed' },
				input: obj({ value: JavaScriptType.BigInt() }),
				output: obj({ value: Type.String() }),
				execute: () => ({ value: 'never' }),
			}),
		).toThrow(/input must be a portable JSON Schema/)
		expect(() =>
			defineCommand({
				name: 'callback.run',
				description: 'Run a callback.',
				behavior: { kind: 'query', world: 'closed' },
				input: obj({ callback: JavaScriptType.Function([], JavaScriptType.Void()) }),
				output: obj({ value: Type.String() }),
				execute: () => ({ value: 'never' }),
			}),
		).toThrow(/input must be a portable JSON Schema/)
	})

	it('accepts self-contained TypeBox modules and rejects unresolved schema references', async () => {
		const external = Type.Object({ id: Type.String() }, { $id: 'ExternalValue' })
		let failure: unknown
		try {
			defineCommand({
				name: 'reference.external',
				description: 'Reject an external schema reference.',
				behavior: { kind: 'query', world: 'closed' },
				input: obj({ value: Type.Ref(external) }),
				execute() {},
			})
		} catch (error) {
			failure = error
		}
		expect(failure).toMatchObject({
			code: 'COMMAND_CONFIG',
			details: { field: 'input', reason: 'unresolved_reference' },
		})
		expect(failure).toHaveProperty('message', expect.stringContaining('Type.Module().Import()'))

		const values = Type.Module({ Value: Type.Object({ id: Type.String() }) })
		const command = defineCommand({
			name: 'reference.embedded',
			description: 'Accept a self-contained schema reference.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({ value: values.Import('Value') }),
			execute() {},
		})
		expect(command.descriptor.inputSchema).toHaveProperty('properties.value.$defs.Value')
		await expect(command.executeOrThrow({ value: { id: 'value-1' } })).resolves.toBeUndefined()
	})

	it('reports compiler failures from the unified schema compilation stage', () => {
		let failure: unknown
		try {
			defineCommand({
				name: 'reference.missing.local',
				description: 'Reject a missing local reference.',
				behavior: { kind: 'query', world: 'closed' },
				input: obj({ value: Type.Ref('#/$defs/Missing') }),
				execute() {},
			})
		} catch (error) {
			failure = error
		}
		expect(failure).toMatchObject({
			code: 'COMMAND_CONFIG',
			details: { field: 'input', reason: 'schema_compile_failed' },
			cause: expect.anything(),
		})
	})

	it('uses TypeBox transforms as private codecs around the JSON command boundary', async () => {
		let dateDecodes = 0
		let dateEncodes = 0
		const date = Type.Transform(Type.String())
			.Decode((value) => {
				dateDecodes += 1
				const decoded = new Date(value)
				if (Number.isNaN(decoded.valueOf())) throw new Error('Invalid ISO date')
				return decoded
			})
			.Encode((value) => {
				dateEncodes += 1
				return value.toISOString()
			})
		const integer = Type.Transform(Type.String({ pattern: '^-?\\d+$' }))
			.Decode((value) => BigInt(value))
			.Encode((value) => String(value))
		const command = defineCommand({
			name: 'ledger.advance',
			description: 'Advance one ledger value.',
			behavior: { kind: 'mutation', destructive: false, idempotent: false, world: 'closed' },
			input: obj({ at: date, value: integer }),
			output: obj({ at: date, value: integer }),
			examples: [
				{
					input: { at: '2026-07-27T00:00:00.000Z', value: '41' },
					output: { at: '2026-07-27T00:00:00.000Z', value: '42' },
				},
			],
			validate(input) {
				expect(input.at).toBeInstanceOf(Date)
				expect(typeof input.value).toBe('bigint')
			},
			validateOutput(output) {
				expect(output.at).toBeInstanceOf(Date)
				expect(typeof output.value).toBe('bigint')
			},
			execute: ({ at, value }) => ({ at, value: value + 1n }),
		})

		expect(dateDecodes).toBe(0)
		expect(dateEncodes).toBe(0)
		expect(command.descriptor.inputSchema).toMatchObject({
			type: 'object',
			properties: { at: { type: 'string' }, value: { type: 'string' } },
		})
		expect(JSON.parse(JSON.stringify(command.descriptor))).toEqual(command.descriptor)
		await expect(
			command.executeOrThrow({ at: '2026-07-27T00:00:00.000Z', value: '41' }),
		).resolves.toEqual({ at: '2026-07-27T00:00:00.000Z', value: '42' })
		expect(dateDecodes).toBe(2)
		expect(dateEncodes).toBe(1)
	})

	it('maps transform failures to the relevant validation boundary', async () => {
		const date = Type.Transform(Type.String())
			.Decode((value) => {
				const decoded = new Date(value)
				if (Number.isNaN(decoded.valueOf())) throw new Error('Invalid ISO date')
				return decoded
			})
			.Encode((value) => value.toISOString())
		const echo = defineCommand({
			name: 'date.echo',
			description: 'Echo one date.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({ value: date }),
			output: obj({ value: date }),
			execute: ({ value }) => ({ value }),
		})
		await expect(echo.executeOrThrow({ value: 'not-a-date' })).rejects.toMatchObject({
			code: 'INPUT_VALIDATION',
			details: { issues: [{ code: 'codec_decode' }] },
		})

		const broken = defineCommand({
			name: 'date.invalid.output',
			description: 'Return one invalid date.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({}),
			output: obj({ value: date }),
			execute: () => ({ value: new Date(Number.NaN) }),
		})
		await expect(broken.executeOrThrow({})).rejects.toMatchObject({
			code: 'OUTPUT_VALIDATION',
			kind: 'fault',
			details: { issues: [{ code: 'codec_encode' }] },
		})
	})

	it('checks abort and deadline around execution', async () => {
		const command = incrementCommand()
		const controller = new AbortController()
		const abortReason = new Error('stopped')
		controller.abort(abortReason)
		const aborted = await command.execute({ value: 1 }, { signal: controller.signal })
		expect(aborted).toMatchObject({ ok: false, error: { code: 'ABORTED' } })
		if (aborted.ok !== false) throw new Error('expected cancellation')
		expect(aborted.error.cause).toBe(abortReason)
		expect(aborted.error.details).toBeUndefined()
		await expect(
			command.executeOrThrow({ value: 1 }, { deadlineMs: Date.now() - 1 }),
		).rejects.toMatchObject({ code: 'TIMEOUT' })
		await expect(
			command.executeOrThrow({ value: 1 }, { deadlineMs: Number.NaN }),
		).rejects.toMatchObject({ code: 'INTERNAL' })
	})

	it('observes cancellation that occurs during asynchronous output validation', async () => {
		let markValidating!: () => void
		let releaseValidation!: () => void
		const validating = new Promise<void>((resolve) => {
			markValidating = resolve
		})
		const validationGate = new Promise<void>((resolve) => {
			releaseValidation = resolve
		})
		const command = defineCommand({
			name: 'validation.cancel',
			description: 'Observe cancellation across the full validation pipeline.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({}),
			output: obj({ ok: Type.Boolean() }),
			async validateOutput() {
				markValidating()
				await validationGate
			},
			execute: () => ({ ok: true }),
		})
		const controller = new AbortController()
		const pending = command.executeOrThrow({}, { signal: controller.signal })

		await validating
		controller.abort('stopped')
		releaseValidation()
		await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
	})

	it('maintains one cached immutable registry catalog', async () => {
		const registry = createCommandRegistry()
		const registration = registry.register(incrementCommand())
		const first = registry.list()
		expect(Object.isFrozen(first)).toBe(true)
		expect(registry.list()).toBe(first)
		await expect(registry.executeOrThrow('math.increment', { value: 1 })).resolves.toEqual({
			value: 2,
		})
		expect(() => registry.register(incrementCommand())).toThrow(/already registered/)
		registration.dispose()
		registration.dispose()
		expect(registry.list()).toEqual([])
	})

	it('disposes catalog visibility without pretending to cancel in-flight execution', async () => {
		let markStarted!: () => void
		let release!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const command = defineCommand({
			name: 'registry.inflight',
			description: 'Complete one in-flight command.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({}),
			output: obj({ completed: Type.Boolean() }),
			async execute() {
				markStarted()
				await gate
				return { completed: true }
			},
		})
		const registry = createCommandRegistry()
		const registration = registry.register(command)
		const pending = registry.executeOrThrow('registry.inflight', {})

		await started
		registration.dispose()
		expect(registry.get('registry.inflight')).toBeUndefined()
		release()
		await expect(pending).resolves.toEqual({ completed: true })
	})

	it('rejects inconsistent commands and orders catalogs without locale rules', () => {
		const registry = createCommandRegistry()
		const command = incrementCommand()
		expect(() => registry.register({ ...command, name: 'math.other' })).toThrow(
			/does not match descriptor name/,
		)

		const upper = defineCommand({
			name: 'Alpha.command',
			description: 'Uppercase command.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({}),
			execute() {},
		})
		const lower = defineCommand({
			name: 'alpha.command',
			description: 'Lowercase command.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({}),
			execute() {},
		})
		registry.register(lower)
		registry.register(upper)
		expect(registry.list().map(({ name }) => name)).toEqual(['Alpha.command', 'alpha.command'])
	})

	it('captures registry identity from an otherwise mutable command wrapper', () => {
		const registry = createCommandRegistry()
		const command = incrementCommand()
		const wrapper = { ...command }
		const registration = registry.register(wrapper)
		Object.assign(wrapper, { name: 'math.changed', descriptor: { name: 'math.changed' } })

		expect(registration.name).toBe('math.increment')
		expect(registry.get('math.increment')).toBe(wrapper)
		expect(registry.list()).toEqual([command.descriptor])
		registration.dispose()
		expect(registry.list()).toEqual([])
	})

	it('snapshots mutable external descriptors without freezing caller data', () => {
		const registry = createCommandRegistry()
		const command = incrementCommand()
		const descriptor = JSON.parse(JSON.stringify(command.descriptor)) as typeof command.descriptor
		const wrapper = { ...command, descriptor }
		registry.register(wrapper)

		expect(Object.isFrozen(descriptor)).toBe(false)
		Object.assign(descriptor, { description: 'Changed externally.' })
		expect(registry.list()[0]?.description).toBe('Increment a number.')
	})

	it('validates deeply frozen external descriptors before reusing their identity', () => {
		const command = incrementCommand()
		const descriptor = Object.freeze({
			name: command.name,
			description: command.descriptor.description,
			behavior: Object.freeze({ kind: 'query', world: 'closed' } as const),
			inputSchema: Object.freeze({
				type: 'object',
				annotation: Object.freeze(new Date('2026-07-27T00:00:00.000Z')),
			}),
		})
		const registry = createCommandRegistry()

		let failure: unknown
		try {
			registry.register({ ...command, descriptor })
		} catch (error) {
			failure = error
		}
		expect(failure).toMatchObject({
			code: 'COMMAND_CONFIG',
			details: { command: 'math.increment', reason: 'invalid_descriptor' },
			cause: expect.objectContaining({ message: expect.stringContaining('not valid JSON') }),
		})
	})
})

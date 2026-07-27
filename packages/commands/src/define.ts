import { compileDescriptor, withExamples } from './compile'
import { TransformDecodeError } from '@sinclair/typebox/value'
import { compileCodec, type JsonCodec, type JsonValidator } from './schema'
import {
	CommandError,
	toCommandError,
	type Command,
	type CommandContext,
	type CommandContextArgs,
	type CommandErrorCode,
	type CommandExample,
	type CommandResult,
	type DefineCommandConfig,
	type Infer,
	type ObjectSchema,
	type OutputCommandDefinition,
	type ValidationIssue,
	type Validator,
	type VoidCommandDefinition,
	type Wire,
} from './types'

type ValidationSpec<S extends ObjectSchema, Ctx extends CommandContext> = {
	codec: JsonCodec<S>
	custom?: Validator<Infer<S>, Ctx>
}

function assertActive(context?: CommandContext): void {
	if (!context) return
	if (context.signal?.aborted) {
		throw new CommandError('ABORTED', 'Command cancelled', {
			cause: context.signal.reason,
		})
	}
	if (context.deadlineMs === undefined) return
	if (!Number.isFinite(context.deadlineMs)) {
		throw new CommandError('INTERNAL', 'Command failed', {
			message: 'Command context deadlineMs must be a finite Unix timestamp',
		})
	}
	const now = Date.now()
	if (now > context.deadlineMs) {
		throw new CommandError('TIMEOUT', 'Command timed out', {
			details: { now, deadlineMs: context.deadlineMs },
		})
	}
}

async function validateInput<S extends ObjectSchema, Ctx extends CommandContext>(
	spec: ValidationSpec<S, Ctx>,
	candidate: unknown,
	context: Ctx,
): Promise<Infer<S>> {
	const result = spec.codec.input(candidate)
	if (result.ok !== true) {
		throw new CommandError('INPUT_VALIDATION', validationPublicMessage('INPUT_VALIDATION'), {
			details: { issues: result.issues },
		})
	}
	let decoded: Infer<S>
	try {
		decoded = spec.codec.decode(result.value)
	} catch (error) {
		const intentional = intentionalInputDecodeError(error)
		if (intentional) throw intentional
		throw codecError('INPUT_VALIDATION', 'decode', error)
	}
	await validateCustom(spec.custom, decoded, 'INPUT_VALIDATION', context)
	return decoded
}

function intentionalInputDecodeError(error: unknown): CommandError<'INPUT_VALIDATION'> | undefined {
	let current = error
	while (true) {
		if (current instanceof CommandError && current.code === 'INPUT_VALIDATION') {
			return current as CommandError<'INPUT_VALIDATION'>
		}
		if (!(current instanceof TransformDecodeError)) return undefined
		current = current.error
	}
}

async function validateOutput<S extends ObjectSchema, Ctx extends CommandContext>(
	spec: ValidationSpec<S, Ctx>,
	candidate: Infer<S>,
	context: Ctx,
): Promise<Wire<S>> {
	let encoded: Wire<S>
	try {
		encoded = spec.codec.encode(candidate)
	} catch (error) {
		throw codecError('OUTPUT_VALIDATION', 'encode', error)
	}
	const result = spec.codec.output(encoded)
	if (result.ok !== true) {
		throw new CommandError('OUTPUT_VALIDATION', validationPublicMessage('OUTPUT_VALIDATION'), {
			details: { issues: result.issues },
		})
	}
	if (spec.custom) {
		let decoded: Infer<S>
		try {
			decoded = spec.codec.decode(result.value)
		} catch (error) {
			throw codecError('OUTPUT_VALIDATION', 'decode', error)
		}
		await validateCustom(spec.custom, decoded, 'OUTPUT_VALIDATION', context)
	}
	return result.value
}

async function validateCustom<T, Ctx extends CommandContext>(
	validator: Validator<T, Ctx> | undefined,
	value: T,
	code: Extract<CommandErrorCode, 'INPUT_VALIDATION' | 'OUTPUT_VALIDATION'>,
	context: Ctx,
): Promise<void> {
	if (!validator) return
	const custom = await validator(value, context)
	const issues = custom ? (Array.isArray(custom) ? custom : [custom]) : []
	if (issues.length > 0) {
		throw new CommandError(code, validationPublicMessage(code), { details: { issues } })
	}
}

function codecError(
	code: Extract<CommandErrorCode, 'INPUT_VALIDATION' | 'OUTPUT_VALIDATION'>,
	direction: 'decode' | 'encode',
	error: unknown,
): CommandError {
	return new CommandError(code, validationPublicMessage(code), {
		message: error instanceof Error ? error.message : `Command codec failed to ${direction} value`,
		details: {
			issues: [
				{
					message: `Command value could not be ${direction === 'decode' ? 'decoded' : 'encoded'}`,
					code: `codec_${direction}`,
				},
			],
		},
		cause: error,
	})
}

function validationPublicMessage(
	code: Extract<CommandErrorCode, 'INPUT_VALIDATION' | 'OUTPUT_VALIDATION'>,
): string {
	return code === 'INPUT_VALIDATION' ? 'Invalid command input' : 'Command failed'
}

function normalizeFailure(error: unknown): CommandError {
	return toCommandError(error, 'INTERNAL', 'Command failed')
}

type PublicOutput<S extends ObjectSchema | undefined> = S extends ObjectSchema ? Wire<S> : void

export function defineCommand<
	SIn extends ObjectSchema,
	SOut extends ObjectSchema,
	Ctx extends CommandContext = CommandContext,
>(config: OutputCommandDefinition<SIn, SOut, Ctx>): Command<Wire<SIn>, Wire<SOut>, Ctx>
export function defineCommand<
	SIn extends ObjectSchema,
	Ctx extends CommandContext = CommandContext,
>(config: VoidCommandDefinition<SIn, Ctx>): Command<Wire<SIn>, void, Ctx>
export function defineCommand<
	SIn extends ObjectSchema,
	SOut extends ObjectSchema | undefined,
	Ctx extends CommandContext = CommandContext,
>(config: DefineCommandConfig<SIn, SOut, Ctx>): Command<Wire<SIn>, PublicOutput<SOut>, Ctx> {
	type OutputSchema = Extract<SOut, ObjectSchema>
	type WireOutput = PublicOutput<SOut>
	const baseDescriptor = compileDescriptor(config)
	const input: ValidationSpec<SIn, Ctx> = {
		codec: commandCodec(config.name, 'input', config.input),
		...(config.validate ? { custom: config.validate } : {}),
	}
	const output: ValidationSpec<OutputSchema, Ctx> | undefined = config.output
		? {
				codec: commandCodec(config.name, 'output', config.output as OutputSchema),
				...(config.validateOutput
					? { custom: config.validateOutput as Validator<Infer<OutputSchema>, Ctx> }
					: {}),
			}
		: undefined
	const examples = normalizeExamples(
		config.name,
		config.examples,
		input.codec.input,
		output?.codec.output,
	)
	const descriptor = withExamples(baseDescriptor, examples)
	const name = config.name
	const implementation = config.execute

	async function executeOrThrow(
		candidate: unknown,
		...context: CommandContextArgs<Ctx>
	): Promise<WireOutput> {
		const currentContext = (context[0] ?? {}) as Ctx
		try {
			assertActive(currentContext)
			const inputValue = await validateInput(input, candidate, currentContext)
			assertActive(currentContext)
			const outputCandidate = await implementation(inputValue, currentContext)
			assertActive(currentContext)
			if (!output) {
				if (outputCandidate !== undefined) throw unexpectedOutput()
				return undefined as WireOutput
			}
			const outputValue = (await validateOutput(
				output,
				outputCandidate as Infer<OutputSchema>,
				currentContext,
			)) as WireOutput
			assertActive(currentContext)
			return outputValue
		} catch (error) {
			throw normalizeFailure(error)
		}
	}

	return {
		name,
		descriptor,
		executeOrThrow,
		async execute(
			candidate: unknown,
			...context: CommandContextArgs<Ctx>
		): Promise<CommandResult<WireOutput>> {
			try {
				return { ok: true, value: await executeOrThrow(candidate, ...context) }
			} catch (error) {
				return { ok: false, error: normalizeFailure(error) }
			}
		},
	}
}

function unexpectedOutput(): CommandError<'OUTPUT_VALIDATION'> {
	return new CommandError('OUTPUT_VALIDATION', 'Command failed', {
		message: 'Command returned a value without declaring an output schema',
		details: {
			issues: [
				{
					message: 'Command must return undefined when output is omitted',
					code: 'unexpected_output',
				},
			],
		},
	})
}

function commandCodec<S extends ObjectSchema>(
	command: string,
	field: 'input' | 'output',
	schema: S,
): JsonCodec<S> {
	try {
		return compileCodec(schema)
	} catch (error) {
		throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
			message: `Command "${command}" ${field} schema could not be compiled`,
			details: { command, field, reason: 'schema_compile_failed' },
			cause: error,
		})
	}
}

function normalizeExamples<Input, Output>(
	command: string,
	examples: readonly CommandExample<Input, Output>[] | undefined,
	validateExampleInput: JsonValidator<Input>,
	validateExampleOutput: JsonValidator<Output> | undefined,
): readonly CommandExample[] | undefined {
	if (!examples?.length) return undefined
	return examples.map((example, index) => {
		const input = validateExampleInput(example.input)
		if (input.ok !== true) throw invalidExample(command, index, 'input', input.issues)
		const hasOutput = Object.hasOwn(example, 'output')
		if (hasOutput && !validateExampleOutput) {
			throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
				message: `Command "${command}" example ${index + 1} declares output without an output schema`,
				details: { command, field: 'examples', reason: 'unexpected_example_output' },
			})
		}
		const output = hasOutput ? validateExampleOutput!(example.output) : undefined
		if (output && output.ok !== true) {
			throw invalidExample(command, index, 'output', output.issues)
		}
		const title = normalizeExampleTitle(command, index, example.title)
		return {
			...(title ? { title } : {}),
			input: input.value,
			...(output?.ok ? { output: output.value } : {}),
		}
	})
}

function normalizeExampleTitle(
	command: string,
	index: number,
	value: string | undefined,
): string | undefined {
	const title = value?.trim()
	if (!title) return undefined
	if (title.includes('\n') || title.length > 120) {
		throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
			message: `Command "${command}" example ${index + 1} title must be one line of at most 120 characters`,
			details: { command, field: 'examples', reason: 'invalid_example_title' },
		})
	}
	return title
}

function invalidExample(
	command: string,
	index: number,
	part: 'input' | 'output',
	issues: ValidationIssue[],
): CommandError<'COMMAND_CONFIG'> {
	return new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
		message: `Command "${command}" example ${index + 1} has invalid ${part}: ${issues.map((issue) => issue.message).join('; ')}`,
		details: { command, field: 'examples', reason: `invalid_example_${part}` },
	})
}

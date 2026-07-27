import { deepFreeze } from './internal/freeze'
import { assertJsonValue, markStrictJsonSnapshot } from './internal/json'
import {
	compileSchema,
	SchemaCompilationError,
	SchemaDefaultError,
	SchemaReferenceError,
	type CompiledSchema,
	type JsonValidator,
} from './schema'
import {
	CommandError,
	type CommandBehavior,
	type CommandDescriptor,
	type CommandExample,
	type DefineCommandConfig,
	type ObjectSchema,
	type ValidationIssue,
} from './types'

const commandNamePattern = /^[A-Za-z0-9_.-]{1,128}$/
const maxTitleLength = 120
const maxDescriptionLength = 4_000

type CommandMetadata = Pick<CommandDescriptor, 'name' | 'description' | 'behavior'> & {
	title?: string
}

export type CompiledCommand<SIn extends ObjectSchema, SOut extends ObjectSchema | undefined> = {
	readonly descriptor: CommandDescriptor
	readonly input: CompiledSchema<SIn>
	readonly output?: CompiledSchema<Extract<SOut, ObjectSchema>>
}

function configError(message: string, command?: string, field?: string): never {
	throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
		message,
		details: { ...(command ? { command } : {}), ...(field ? { field } : {}) },
	})
}

function normalizeTitle(value: string | undefined, name: string): string | undefined {
	const output = value?.trim()
	if (!output) return undefined
	if (output.includes('\n')) configError(`title for "${name}" must be a single line`, name, 'title')
	if (output.length > maxTitleLength) {
		configError(`title for "${name}" must be at most ${maxTitleLength} characters`, name, 'title')
	}
	return output
}

function normalizeDescription(value: string | undefined, name: string): string {
	const output = value?.trim()
	if (!output) configError(`Command "${name}" must define description`, name, 'description')
	if (output.length > maxDescriptionLength) {
		configError(
			`description for "${name}" must be at most ${maxDescriptionLength} characters`,
			name,
			'description',
		)
	}
	return output
}

function normalizeBehavior(name: string, behavior: CommandBehavior | undefined): CommandBehavior {
	if (!behavior || (behavior.kind !== 'query' && behavior.kind !== 'mutation')) {
		configError(`Command "${name}" must define query or mutation behavior`, name, 'behavior')
	}
	if (behavior.world !== 'closed' && behavior.world !== 'open') {
		configError(`Command "${name}" behavior must define a closed or open world`, name, 'behavior')
	}
	if (
		behavior.kind === 'mutation' &&
		(typeof behavior.destructive !== 'boolean' || typeof behavior.idempotent !== 'boolean')
	) {
		configError(
			`Mutation command "${name}" must explicitly define destructive and idempotent`,
			name,
			'behavior',
		)
	}
	return behavior.kind === 'query'
		? { kind: 'query', world: behavior.world }
		: {
				kind: 'mutation',
				destructive: behavior.destructive,
				idempotent: behavior.idempotent,
				world: behavior.world,
			}
}

export function compileCommand<SIn extends ObjectSchema, SOut extends ObjectSchema | undefined>(
	config: DefineCommandConfig<SIn, SOut, any>,
): CompiledCommand<SIn, SOut> {
	const metadata = normalizeMetadata(config)
	const input = compileCommandSchema(metadata.name, 'input', config.input)
	const output = config.output
		? compileCommandSchema(metadata.name, 'output', config.output as Extract<SOut, ObjectSchema>)
		: undefined
	if (input.jsonSchema.type !== 'object') {
		configError(`Command "${metadata.name}" input must be an object schema`, metadata.name, 'input')
	}
	if (output && output.jsonSchema.type !== 'object') {
		configError(
			`Command "${metadata.name}" output must be an object schema`,
			metadata.name,
			'output',
		)
	}
	const examples = normalizeExamples(
		metadata.name,
		config.examples,
		input.validateInput,
		output?.validateOutput,
	)
	const descriptor = freezeJsonSnapshot({
		...metadata,
		inputSchema: input.jsonSchema,
		...(output ? { outputSchema: output.jsonSchema } : {}),
		...(examples?.length ? { examples } : {}),
	})
	return Object.freeze({ descriptor, input, ...(output ? { output } : {}) })
}

function normalizeMetadata<SIn extends ObjectSchema, SOut extends ObjectSchema | undefined>(
	config: DefineCommandConfig<SIn, SOut, any>,
): CommandMetadata {
	if (typeof config.name !== 'string') {
		configError('Command name must be a string', undefined, 'name')
	}
	if (!commandNamePattern.test(config.name)) {
		configError(
			`Command name "${config.name}" must contain 1-128 letters, digits, dots, underscores, or hyphens`,
			config.name,
			'name',
		)
	}
	const title = normalizeTitle(config.title, config.name)
	return {
		name: config.name,
		...(title ? { title } : {}),
		description: normalizeDescription(config.description, config.name),
		behavior: normalizeBehavior(config.name, config.behavior),
	}
}

function freezeJsonSnapshot<T extends object>(value: T): T {
	assertJsonValue(value)
	return markStrictJsonSnapshot(deepFreeze(value))
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
	if (title.includes('\n') || title.length > maxTitleLength) {
		throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
			message: `Command "${command}" example ${index + 1} title must be one line of at most ${maxTitleLength} characters`,
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

function compileCommandSchema<S extends ObjectSchema>(
	command: string,
	field: 'input' | 'output',
	schema: S,
): CompiledSchema<S> {
	try {
		return compileSchema(schema)
	} catch (error) {
		if (error instanceof SchemaDefaultError) {
			throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
				message: `Command "${command}" ${field} schema ${error.message.charAt(0).toLowerCase()}${error.message.slice(1)}`,
				details: {
					command,
					field,
					reason: 'invalid_default',
					path: error.path,
				},
				cause: error,
			})
		}
		if (error instanceof SchemaReferenceError) {
			throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
				message: `Command "${command}" ${field} schema ${error.message.charAt(0).toLowerCase()}${error.message.slice(1)}`,
				details: {
					command,
					field,
					reason: 'unresolved_reference',
				},
				cause: error,
			})
		}
		if (error instanceof SchemaCompilationError) {
			throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
				message: `Command "${command}" ${field} schema could not be compiled`,
				details: { command, field, reason: 'schema_compile_failed' },
				cause: error.cause,
			})
		}
		throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
			message: `Command "${command}" ${field} must be a portable JSON Schema`,
			details: { command, field, reason: 'non_json_schema' },
			cause: error,
		})
	}
}

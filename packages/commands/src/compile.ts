import { deepFreeze } from './internal/freeze'
import { assertJsonValue, markStrictJsonSnapshot } from './internal/json'
import {
	compileSchema,
	SchemaCompilationError,
	SchemaDefaultError,
	SchemaReferenceError,
	type CompiledSchema,
} from './schema'
import {
	CommandError,
	type CommandDescriptor,
	type DefineCommandConfig,
	type ObjectSchema,
} from './types'

const commandNamePattern = /^[A-Za-z0-9_.-]{1,128}$/

export type CompiledCommand<SIn extends ObjectSchema> = {
	readonly descriptor: CommandDescriptor
	readonly input: CompiledSchema<SIn>
}

export function compileCommand<SIn extends ObjectSchema>(
	config: DefineCommandConfig<SIn, unknown, any>,
): CompiledCommand<SIn> {
	if (typeof config.name !== 'string' || !commandNamePattern.test(config.name)) {
		throw configError(
			'Command name must contain 1-128 letters, digits, dots, underscores, or hyphens',
			'name',
		)
	}
	const description = typeof config.description === 'string' ? config.description.trim() : ''
	if (!description || description.length > 4_000) {
		throw configError('Command description must contain 1-4000 characters', 'description')
	}
	if (typeof config.execute !== 'function')
		throw configError('Command execute must be a function', 'execute')
	const fields = Object.keys(config)
	for (const field of fields) {
		if (!['name', 'description', 'input', 'execute'].includes(field)) {
			throw configError(`Unknown command definition field "${field}"`, field)
		}
	}
	let input: CompiledSchema<SIn>
	try {
		input = compileSchema(config.input)
	} catch (error) {
		if (
			error instanceof SchemaDefaultError ||
			error instanceof SchemaReferenceError ||
			error instanceof SchemaCompilationError
		) {
			throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
				message: `Command "${config.name}" input schema could not be compiled: ${error.message}`,
				cause: error,
			})
		}
		throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
			message: `Command "${config.name}" input must be a portable JSON Schema`,
			cause: error,
		})
	}
	if (input.jsonSchema.type !== 'object')
		throw configError('Command input must be an object schema', 'input')
	const examples = input.jsonSchema.examples
	if (examples !== undefined) {
		if (!Array.isArray(examples))
			throw configError('Command input examples must be an array', 'input')
		for (const [index, example] of examples.entries()) {
			const checked = input.validateOutput(example)
			if (checked.ok !== true) {
				throw configError(
					`Command input example ${index + 1} is invalid: ${checked.issues.map((issue) => issue.message).join('; ')}`,
					'input',
				)
			}
		}
	}
	const descriptor = { name: config.name, description, inputSchema: input.jsonSchema }
	assertJsonValue(descriptor)
	return Object.freeze({ descriptor: markStrictJsonSnapshot(deepFreeze(descriptor)), input })
}

function configError(message: string, field: string): CommandError<'COMMAND_CONFIG'> {
	return new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
		message,
		details: { field },
	})
}

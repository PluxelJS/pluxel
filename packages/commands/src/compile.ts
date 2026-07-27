import { deepFreeze } from './internal/freeze'
import { assertJsonValue, markStrictJsonSnapshot } from './internal/json'
import { SchemaDefaultError, SchemaReferenceError, toJsonSchema } from './schema'
import {
	CommandError,
	type CommandBehavior,
	type CommandDescriptor,
	type CommandExample,
	type DefineCommandConfig,
	type ObjectSchema,
} from './types'

const commandNamePattern = /^[A-Za-z0-9_.-]{1,128}$/
const maxTitleLength = 120
const maxDescriptionLength = 4_000

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

export function compileDescriptor<SIn extends ObjectSchema, SOut extends ObjectSchema | undefined>(
	config: DefineCommandConfig<SIn, SOut, any>,
): CommandDescriptor {
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
	const inputSchema = normalizeSchema(config.name, 'input', config.input)
	const outputSchema = config.output
		? normalizeSchema(config.name, 'output', config.output)
		: undefined
	if (inputSchema.type !== 'object') {
		configError(`Command "${config.name}" input must be an object schema`, config.name, 'input')
	}
	if (outputSchema && outputSchema.type !== 'object') {
		configError(`Command "${config.name}" output must be an object schema`, config.name, 'output')
	}
	return freezeJsonSnapshot({
		name: config.name,
		...(title ? { title } : {}),
		description: normalizeDescription(config.description, config.name),
		behavior: normalizeBehavior(config.name, config.behavior),
		inputSchema,
		...(outputSchema ? { outputSchema } : {}),
	})
}

export function withExamples(
	descriptor: CommandDescriptor,
	examples: readonly CommandExample[] | undefined,
): CommandDescriptor {
	return examples?.length ? freezeJsonSnapshot({ ...descriptor, examples }) : descriptor
}

function freezeJsonSnapshot<T extends object>(value: T): T {
	assertJsonValue(value)
	return markStrictJsonSnapshot(deepFreeze(value))
}

function normalizeSchema(
	command: string,
	field: 'input' | 'output',
	schema: ObjectSchema,
): Record<string, unknown> {
	try {
		return toJsonSchema(schema)
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
		throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
			message: `Command "${command}" ${field} must be a portable JSON Schema`,
			details: { command, field, reason: 'non_json_schema' },
			cause: error,
		})
	}
}

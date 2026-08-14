import {
	CommandError,
	type AnyCommand,
	type CommandContext,
	type CommandContextArgs,
	type CommandDescriptor,
	type CommandResult,
} from '../types'
import { requiresJsonArgvFormat } from './compile'
import { createArgvRouter, type ArgvRouter } from './router'
import { closestSuggestions, suggestionSuffix } from './suggest'
import { tokenizeArgv } from './tokenize'
import type { ArgvBinding, ArgvCommandDescriptor, ArgvInput, ArgvResolution } from './types'

/** The live catalog surface required by the default argv projection. */
export type CommandArgvCatalog<Ctx extends CommandContext = CommandContext> = {
	get(name: string): AnyCommand<Ctx> | undefined
	list(): readonly CommandDescriptor[]
	executeOrThrow(
		name: string,
		candidate: unknown,
		...context: CommandContextArgs<Ctx>
	): Promise<unknown>
}

/** A lazy default argv projection over the current contents of a command catalog. */
export type CommandArgvAdapter<Ctx extends CommandContext = CommandContext> = {
	resolve(input: ArgvInput): ArgvResolution<Ctx> | undefined
	dispatch(input: ArgvInput, ...context: CommandContextArgs<Ctx>): Promise<CommandResult<unknown>>
	dispatchOrThrow(input: ArgvInput, ...context: CommandContextArgs<Ctx>): Promise<unknown>
	help(name: string): ArgvCommandDescriptor | undefined
}

class CommandArgvAdapterImpl<Ctx extends CommandContext> implements CommandArgvAdapter<Ctx> {
	private readonly routers = new WeakMap<AnyCommand<Ctx>, ArgvRouter<Ctx>>()

	constructor(private readonly catalog: CommandArgvCatalog<Ctx>) {}

	resolve(input: ArgvInput): ArgvResolution<Ctx> | undefined {
		const name = firstToken(input)
		if (!name) return undefined
		const command = this.catalog.get(name)
		if (!command) return undefined
		return this.router(command).resolve(input)
	}

	async dispatch(
		input: ArgvInput,
		...context: CommandContextArgs<Ctx>
	): Promise<CommandResult<unknown>> {
		try {
			return { ok: true, value: await this.dispatchOrThrow(input, ...context) }
		} catch (error) {
			return {
				ok: false,
				error:
					error instanceof CommandError
						? error
						: new CommandError('INTERNAL', 'Command failed', { cause: error }),
			}
		}
	}

	async dispatchOrThrow(input: ArgvInput, ...context: CommandContextArgs<Ctx>): Promise<unknown> {
		const resolution = this.resolve(input)
		if (!resolution) throw this.commandNotFound(input)
		return this.catalog.executeOrThrow(resolution.command.name, resolution.candidate, ...context)
	}

	help(name: string): ArgvCommandDescriptor | undefined {
		const command = this.catalog.get(name)
		return command ? this.router(command).help(name) : undefined
	}

	private router(command: AnyCommand<Ctx>): ArgvRouter<Ctx> {
		let router = this.routers.get(command)
		if (router) return router
		router = createArgvRouter<Ctx>()
		router.bind(command, defaultBinding(command))
		this.routers.set(command, router)
		return router
	}

	private commandNotFound(input: ArgvInput): CommandError<'COMMAND_NOT_FOUND'> {
		const name = firstToken(input)
		const suggestions = name
			? closestSuggestions(
					this.catalog.list().map((descriptor) => ({
						compare: name,
						display: descriptor.name,
					})),
				)
			: []
		return new CommandError('COMMAND_NOT_FOUND', 'Command not found', {
			message: name
				? `Command "${name}" is not registered${suggestionSuffix(suggestions)}`
				: 'Command name is required',
			details: {
				...(name ? { name } : {}),
				input: argvSource(input),
				...(suggestions.length > 0 ? { suggestions } : {}),
			},
		})
	}
}

/**
 * Project a live command catalog into conservative argv syntax.
 *
 * The exact first token selects the command. Scalar fields become named options and complex fields
 * use field-level JSON. Use `createArgvRouter()` when a carrier needs custom routes or positionals.
 */
export function createCommandArgv<Ctx extends CommandContext = CommandContext>(
	catalog: CommandArgvCatalog<Ctx>,
): CommandArgvAdapter<Ctx> {
	return new CommandArgvAdapterImpl(catalog)
}

function defaultBinding<Ctx extends CommandContext>(
	command: AnyCommand<Ctx>,
): ArgvBinding<Record<string, unknown>> {
	const schema = command.descriptor.inputSchema
	const properties =
		schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
			? (schema.properties as Record<string, unknown>)
			: {}
	const options: Record<string, { format: 'json' }> = {}
	for (const [key, value] of Object.entries(properties)) {
		if (
			value &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			requiresJsonArgvFormat(value as Record<string, unknown>)
		) {
			options[key] = { format: 'json' }
		}
	}
	return {
		routes: [command.name],
		...(Object.keys(options).length > 0 ? { options } : {}),
	}
}

function firstToken(input: ArgvInput): string | undefined {
	return typeof input === 'string' ? tokenizeArgv(input)[0]?.value : input[0]
}

function argvSource(input: ArgvInput): string {
	return typeof input === 'string' ? input : input.join(' ')
}

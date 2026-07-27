import { deepFreeze, isDeepFrozen } from './internal/freeze'
import {
	assertJsonValue,
	cloneJsonValue,
	isStrictJsonSnapshot,
	markStrictJsonSnapshot,
} from './internal/json'
import { compareStrings } from './internal/compare'
import {
	CommandError,
	type AnyCommand,
	type CommandContext,
	type CommandContextArgs,
	type CommandDescriptor,
	type CommandResult,
	type Registration,
} from './types'

type RegistryEntry<Ctx extends CommandContext> = {
	command: AnyCommand<Ctx>
	descriptor: CommandDescriptor
}

export class CommandRegistry<Ctx extends CommandContext = CommandContext> {
	private readonly entries = new Map<string, RegistryEntry<Ctx>>()
	private revision = 0
	private listRevision = -1
	private listCache: readonly CommandDescriptor[] = []

	register(command: AnyCommand<Ctx>): Registration {
		const name = command.name
		const descriptor = descriptorSnapshot(command.descriptor, name)
		if (descriptor.name !== name) {
			throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
				message: `Command name "${name}" does not match descriptor name "${descriptor.name}"`,
				details: { command: name, reason: 'descriptor_name_mismatch' },
			})
		}
		if (this.entries.has(name)) {
			throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
				message: `Command "${name}" is already registered`,
				details: { command: name, reason: 'duplicate_name' },
			})
		}
		const entry = { command, descriptor }
		this.entries.set(name, entry)
		this.bumpRevision()
		let active = true
		return {
			name,
			dispose: () => {
				if (!active) return
				active = false
				if (this.entries.get(name) === entry) {
					this.entries.delete(name)
					this.bumpRevision()
				}
			},
		}
	}

	get(name: string): AnyCommand<Ctx> | undefined {
		return this.entries.get(name)?.command
	}

	list(): readonly CommandDescriptor[] {
		if (this.listRevision === this.revision) return this.listCache
		this.listCache = deepFreeze(
			[...this.entries.values()]
				.map((entry) => entry.descriptor)
				.sort((left, right) => compareStrings(left.name, right.name)),
		)
		this.listRevision = this.revision
		return this.listCache
	}

	async execute(
		name: string,
		candidate: unknown,
		...context: CommandContextArgs<Ctx>
	): Promise<CommandResult<unknown>> {
		const entry = this.entries.get(name)
		if (!entry) {
			return {
				ok: false,
				error: new CommandError('COMMAND_NOT_FOUND', 'Command not found', {
					message: `Command "${name}" is not registered`,
					details: { name },
				}),
			}
		}
		return entry.command.execute(candidate, ...context)
	}

	async executeOrThrow(
		name: string,
		candidate: unknown,
		...context: CommandContextArgs<Ctx>
	): Promise<unknown> {
		const entry = this.entries.get(name)
		if (!entry) {
			throw new CommandError('COMMAND_NOT_FOUND', 'Command not found', {
				message: `Command "${name}" is not registered`,
				details: { name },
			})
		}
		return entry.command.executeOrThrow(candidate, ...context)
	}

	private bumpRevision(): void {
		this.revision += 1
		this.listRevision = -1
	}
}

function descriptorSnapshot(descriptor: CommandDescriptor, command: string): CommandDescriptor {
	try {
		if (isStrictJsonSnapshot(descriptor)) return descriptor
		if (isDeepFrozen(descriptor)) {
			assertJsonValue(descriptor)
			return markStrictJsonSnapshot(descriptor)
		}
		return markStrictJsonSnapshot(deepFreeze(cloneJsonValue(descriptor) as CommandDescriptor))
	} catch (error) {
		throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
			message: `Command "${command}" descriptor must be strict JSON`,
			details: { command, reason: 'invalid_descriptor' },
			cause: error,
		})
	}
}

export function createCommandRegistry<
	Ctx extends CommandContext = CommandContext,
>(): CommandRegistry<Ctx> {
	return new CommandRegistry<Ctx>()
}

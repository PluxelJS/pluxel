import { compareStrings } from './internal/compare'
import { deepFreeze, isDeepFrozen } from './internal/freeze'
import {
	assertJsonValue,
	cloneJsonValue,
	isStrictJsonSnapshot,
	markStrictJsonSnapshot,
} from './internal/json'
import {
	CommandError,
	type AnyCommand,
	type Command,
	type CommandContext,
	type CommandContextArgs,
	type CommandDescriptor,
	type CommandRegistration,
} from './types'

type RegistryEntry<Ctx extends CommandContext> = {
	command: AnyCommand<Ctx>
	descriptor: CommandDescriptor
	compatibilityKey: string
}

export type CommandCatalogSnapshot = Readonly<{
	revision: number
	descriptors: readonly CommandDescriptor[]
}>

export class CommandRegistry<Ctx extends CommandContext = CommandContext> {
	private readonly entries = new Map<string, RegistryEntry<Ctx>>()
	private readonly listeners = new Set<(snapshot: CommandCatalogSnapshot) => void>()
	private readonly notificationQueue: Array<{
		snapshot: CommandCatalogSnapshot
		listeners: Array<(snapshot: CommandCatalogSnapshot) => void>
	}> = []
	private notifying = false
	private revision = 0
	private snapshotRevision = 0
	private snapshotCache: CommandCatalogSnapshot = deepFreeze({ revision: 0, descriptors: [] })

	register<I, O>(command: Command<I, O, Ctx>): CommandRegistration<I, O, Ctx> {
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

		const compatibilityKey = commandCompatibilityKey(descriptor)
		let active = true
		let entry!: RegistryEntry<Ctx>
		const entries = this.entries
		const bumpRevision = () => this.bumpRevision()
		const installed = Object.freeze({
			name,
			get descriptor(): CommandDescriptor {
				const current = entries.get(name)
				return current?.compatibilityKey === compatibilityKey ? current.descriptor : descriptor
			},
			execute: async (candidate: unknown, ...context: CommandContextArgs<Ctx>): Promise<O> => {
				const current = entries.get(name)
				if (!current) throw commandNotFound(name)
				if (current.compatibilityKey !== compatibilityKey) throw incompatibleInstalledCommand(name)
				return (await current.command.execute(candidate, ...context)) as O
			},
			dispose: () => {
				if (!active) return
				active = false
				if (entries.get(name) !== entry) return
				entries.delete(name)
				bumpRevision()
			},
		}) as CommandRegistration<I, O, Ctx>

		entry = {
			command: command as AnyCommand<Ctx>,
			descriptor,
			compatibilityKey,
		}
		this.entries.set(name, entry)
		this.bumpRevision()
		return installed
	}

	list(): readonly CommandDescriptor[] {
		return this.snapshot().descriptors
	}

	snapshot(): CommandCatalogSnapshot {
		if (this.snapshotRevision === this.revision) return this.snapshotCache
		this.snapshotCache = deepFreeze({
			revision: this.revision,
			descriptors: [...this.entries.values()]
				.map((entry) => entry.descriptor)
				.sort((left, right) => compareStrings(left.name, right.name)),
		})
		this.snapshotRevision = this.revision
		return this.snapshotCache
	}

	subscribe(listener: (snapshot: CommandCatalogSnapshot) => void): () => void {
		this.listeners.add(listener)
		let active = true
		return () => {
			if (!active) return
			active = false
			this.listeners.delete(listener)
		}
	}

	async execute(
		name: string,
		candidate: unknown,
		...context: CommandContextArgs<Ctx>
	): Promise<unknown> {
		const entry = this.entries.get(name)
		if (!entry) throw commandNotFound(name)
		return await entry.command.execute(candidate, ...context)
	}

	private bumpRevision(): void {
		this.revision += 1
		this.snapshotRevision = -1
		if (this.listeners.size === 0) return
		this.notificationQueue.push({ snapshot: this.snapshot(), listeners: [...this.listeners] })
		if (this.notifying) return

		this.notifying = true
		try {
			for (let index = 0; index < this.notificationQueue.length; index += 1) {
				const { snapshot, listeners } = this.notificationQueue[index]!
				for (const listener of listeners) {
					try {
						listener(snapshot)
					} catch {
						// Observation failures cannot make a completed catalog mutation appear to fail.
					}
				}
			}
		} finally {
			this.notificationQueue.length = 0
			this.notifying = false
		}
	}
}

function commandNotFound(name: string): CommandError<'COMMAND_NOT_FOUND'> {
	return new CommandError('COMMAND_NOT_FOUND', 'Command not found', {
		message: `Command "${name}" is not registered`,
		details: { name },
	})
}

function incompatibleInstalledCommand(name: string): CommandError<'COMMAND_NOT_FOUND'> {
	return new CommandError('COMMAND_NOT_FOUND', 'Command not found', {
		message: `Command "${name}" no longer matches the installed command schema`,
		details: { name },
	})
}

function commandCompatibilityKey(descriptor: CommandDescriptor): string {
	return canonicalJson({
		name: descriptor.name,
		inputSchema: descriptor.inputSchema,
		...(descriptor.outputSchema ? { outputSchema: descriptor.outputSchema } : {}),
	})
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
	const object = value as Record<string, unknown>
	return `{${Object.keys(object)
		.sort(compareStrings)
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
		.join(',')}}`
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

import { Result, type Result as BetterResult } from 'better-result'
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
	type CommandFailure,
	type CommandRegistration,
} from './types'

type RegistryEntry<Ctx extends CommandContext> = {
	execute: AnyCommand<Ctx>['execute']
	descriptor: CommandDescriptor
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
		const execute = command.execute
		if (typeof execute !== 'function') {
			throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
				message: `Command "${name}" execute must be a function`,
			})
		}
		if (descriptor.name !== name) {
			throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
				message: `Command name "${name}" does not match descriptor name "${descriptor.name}"`,
			})
		}
		if (this.entries.has(name)) {
			throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
				message: `Command "${name}" is already registered`,
			})
		}
		const invoke = (
			candidate: I,
			...context: CommandContextArgs<Ctx>
		): Promise<BetterResult<O, CommandFailure>> =>
			Reflect.apply(execute, command, [candidate, ...context]) as Promise<
				BetterResult<O, CommandFailure>
			>
		const entry: RegistryEntry<Ctx> = { execute: invoke, descriptor }
		let active = true
		const dispose = () => {
			if (!active) return
			active = false
			if (this.entries.get(name) !== entry) return
			this.entries.delete(name)
			this.bumpRevision()
		}
		const registration = Object.freeze({
			name,
			descriptor,
			execute: (
				candidate: I,
				...context: CommandContextArgs<Ctx>
			): Promise<BetterResult<O, CommandFailure>> =>
				active ? invoke(candidate, ...context) : Promise.resolve(notFound(name)),
			dispose,
			[Symbol.dispose]: dispose,
		}) as CommandRegistration<I, O, Ctx>
		this.entries.set(name, entry)
		this.bumpRevision()
		return registration
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
	): Promise<BetterResult<unknown, CommandFailure>> {
		const entry = this.entries.get(name)
		if (!entry) return notFound(name)
		return entry.execute(candidate, ...context)
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
						/* A subscriber cannot undo a catalog change. */
					}
				}
			}
		} finally {
			this.notificationQueue.length = 0
			this.notifying = false
		}
	}
}

function notFound(name: string): BetterResult<never, CommandFailure> {
	return Result.err({ code: 'COMMAND_NOT_FOUND', message: `Command "${name}" is not registered` })
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
			cause: error,
		})
	}
}

export function createCommandRegistry<
	Ctx extends CommandContext = CommandContext,
>(): CommandRegistry<Ctx> {
	return new CommandRegistry<Ctx>()
}

import {
	CommandError,
	createCommandRegistry,
	type Command,
	type CommandCatalogSnapshot as RegistryCommandCatalogSnapshot,
	type CommandContext,
	type CommandDescriptor,
	type CommandRegistration,
} from '@pluxel/commands'
import type { Context as CoreContext } from '@pluxel/core'
import { enterOwnerInvocation } from '@pluxel/core/internal'
import { createPluginManagementCommands } from './commands/plugin-management'
import { createCommandMount, type CommandMount } from './commands/CommandMount'
import { pinOwnerContext } from '../context/owner-view'

export type CommandCatalogSnapshot = RegistryCommandCatalogSnapshot
export type { CommandMount } from './commands/CommandMount'

export class CommandsService {
	private registry?: ReturnType<typeof createCommandRegistry<CommandContext>>

	constructor(
		public readonly ctx: CoreContext,
		_cfg: unknown,
	) {
		pinOwnerContext(this, ctx)
	}

	/** Register a command until its owner Context stops or the returned handle is disposed. */
	register<I, O>(command: Command<I, O>): CommandRegistration<I, O> {
		return this.registerFor(this.ctx, command)
	}

	/** Create an empty carrier publication mount owned by the calling Context. */
	createMount<Ctx extends CommandContext = CommandContext>(): CommandMount<Ctx> {
		return createCommandMount<Ctx>(this.ctx)
	}

	list(): readonly CommandDescriptor[] {
		return this.rootRegistry().list()
	}

	/** Return the registry's current immutable catalog snapshot. */
	snapshot(): CommandCatalogSnapshot {
		return this.rootRegistry().snapshot()
	}

	/** Subscribe to command publication changes. The caller owns the returned disposer. */
	subscribe(listener: (snapshot: CommandCatalogSnapshot) => void): () => void {
		return this.rootRegistry().subscribe(listener)
	}

	execute(name: string, candidate: unknown, context?: CommandContext): Promise<unknown> {
		return this.rootRegistry().execute(name, candidate, context)
	}

	private rootRegistry(): ReturnType<typeof createCommandRegistry<CommandContext>> {
		const rootService =
			this.ctx === this.ctx.root ? this : (this.ctx.root.commands as CommandsService)
		let registry = rootService.registry
		if (registry) return registry

		const managementCommands = createPluginManagementCommands(this.ctx.root)
		registry = createCommandRegistry()
		rootService.registry = registry
		const registrations: CommandRegistration[] = []
		try {
			for (const command of managementCommands) {
				registrations.push(rootService.registerFor(this.ctx.root, command, registry))
			}
		} catch (error) {
			for (const registration of registrations.toReversed()) registration.dispose()
			rootService.registry = undefined
			throw error
		}
		return registry
	}

	private registerFor<I, O>(
		owner: CoreContext,
		command: Command<I, O>,
		registry = this.rootRegistry(),
	): CommandRegistration<I, O> {
		const registration = registry.register(bindCommandOwner(owner, command))
		let active = true
		const cleanup = () => {
			if (!active) return
			active = false
			registration.dispose()
		}

		let guard: { cancel(): void }
		try {
			guard = owner.effects.defer(cleanup, { tag: `Command:${registration.name}` })
		} catch (error) {
			cleanup()
			throw error
		}

		const ownedRegistration = Object.create(registration) as CommandRegistration<I, O>
		Object.defineProperty(ownedRegistration, 'dispose', {
			value() {
				guard.cancel()
				cleanup()
			},
			enumerable: true,
		})
		return Object.freeze(ownedRegistration)
	}
}

function bindCommandOwner<I, O>(owner: CoreContext, command: Command<I, O>): Command<I, O> {
	return {
		name: command.name,
		descriptor: command.descriptor,
		async execute(candidate: unknown, context?: CommandContext): Promise<O> {
			let lease
			try {
				lease = enterOwnerInvocation(owner, context?.signal)
			} catch (error) {
				throw cancellationError(error)
			}
			try {
				return await command.execute(candidate, {
					...context,
					signal: lease.signal,
				})
			} finally {
				lease.dispose()
			}
		},
	}
}

function cancellationError(error: unknown): CommandError {
	return error instanceof CommandError
		? error
		: new CommandError('ABORTED', 'Command cancelled', { cause: error })
}

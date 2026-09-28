import {
	Result,
	createCommandRegistry,
	type Command,
	type CommandCatalogSnapshot,
	type CommandContext,
	type CommandDescriptor,
	type CommandRegistration,
	type CommandFailure,
} from '@pluxel/commands'
import type { Context as CoreContext } from '@pluxel/core'
import { enterOwnerInvocation } from '@pluxel/core/internal'
import { createCommandMount, type CommandMount } from './mount'
import { pinOwnerContext } from '../internal/owner-view'

export type { CommandCatalogSnapshot } from '@pluxel/commands'
export type { CommandMount } from './mount'

export class CommandsService {
	private registry?: ReturnType<typeof createCommandRegistry<CommandContext>>

	constructor(
		public readonly ctx: CoreContext,
		private readonly rootService?: CommandsService,
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

	execute(
		name: string,
		candidate: unknown,
		context?: CommandContext,
	): Promise<Result<unknown, CommandFailure>> {
		return this.rootRegistry().execute(name, candidate, context)
	}

	private rootRegistry(): ReturnType<typeof createCommandRegistry<CommandContext>> {
		const rootService = this.rootService ?? this
		return (rootService.registry ??= createCommandRegistry())
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
		Object.defineProperty(ownedRegistration, Symbol.dispose, {
			value() {
				guard.cancel()
				cleanup()
			},
		})
		return Object.freeze(ownedRegistration)
	}
}

function bindCommandOwner<I, O>(owner: CoreContext, command: Command<I, O>): Command<I, O> {
	return {
		name: command.name,
		descriptor: command.descriptor,
		async execute(candidate: I, context?: CommandContext): Promise<Result<O, CommandFailure>> {
			let signal: AbortSignal | undefined
			try {
				signal = context?.signal
			} catch (error) {
				return Result.err({ code: 'INTERNAL', message: 'Invalid command context', cause: error })
			}
			if (signal !== undefined && !(signal instanceof AbortSignal)) {
				return Result.err({
					code: 'INTERNAL',
					message: 'Invalid command context',
					cause: new TypeError('Command context signal must be an AbortSignal'),
				})
			}
			let lease
			try {
				lease = enterOwnerInvocation(owner, signal)
			} catch (error) {
				return Result.err(cancellationFailure(error))
			}
			try {
				return await command.execute(candidate, {
					...context,
					signal: lease.signal,
				})
			} catch (error) {
				return Result.err({ code: 'INTERNAL', message: 'Command execution failed', cause: error })
			} finally {
				lease.dispose()
			}
		},
	}
}

function cancellationFailure(error: unknown): CommandFailure {
	return { code: 'ABORTED', message: 'Command cancelled', cause: error }
}

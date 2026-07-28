import {
	CommandError,
	createCommandRegistry,
	type AnyCommand,
	type CommandContext,
	type CommandDescriptor,
	type CommandResult,
	type Registration,
} from '@pluxel/commands'
import { type Context as CoreContext, Injectable } from '@pluxel/core'
import { closeOwnerInvocations, enterOwnerInvocation } from '@pluxel/core/internal'
import { createPluginManagementCommands } from './commands/plugin-management'

const serviceName = 'commands' as const

type RootState = {
	registry: ReturnType<typeof createCommandRegistry<CommandContext>>
}

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: CommandsService
		}
	}
}

@Injectable({ key: serviceName })
export class CommandsService {
	private state?: RootState
	private ownsInvocationCleanup = false

	constructor(
		public ctx: CoreContext,
		_cfg: unknown,
	) {}

	/** Register a command until its owner Context stops or the returned handle is disposed. */
	register(command: AnyCommand): Registration {
		return this.registerFor(this.ctx, command)
	}

	get(name: string): AnyCommand | undefined {
		return this.rootState().registry.get(name)
	}

	list(): readonly CommandDescriptor[] {
		return this.rootState().registry.list()
	}

	execute(
		name: string,
		candidate: unknown,
		context?: CommandContext,
	): Promise<CommandResult<unknown>> {
		return this.rootState().registry.execute(name, candidate, context)
	}

	executeOrThrow(name: string, candidate: unknown, context?: CommandContext): Promise<unknown> {
		return this.rootState().registry.executeOrThrow(name, candidate, context)
	}

	private rootState(): RootState {
		const rootService =
			this.ctx === this.ctx.root ? this : (this.ctx.root.commands as CommandsService)
		let state = rootService.state
		if (state) return state

		const managementCommands = createPluginManagementCommands(this.ctx.root)
		state = { registry: createCommandRegistry() }
		rootService.state = state
		const registrations: Registration[] = []
		try {
			for (const command of managementCommands) {
				registrations.push(rootService.registerFor(this.ctx.root, command, state))
			}
		} catch (error) {
			for (const registration of registrations.toReversed()) registration.dispose()
			rootService.state = undefined
			throw error
		}
		return state
	}

	private registerFor(
		owner: CoreContext,
		command: AnyCommand,
		state = this.rootState(),
	): Registration {
		const registration = state.registry.register(bindCommandOwner(owner, command))
		let active = true
		const cleanup = () => {
			if (!active) return
			active = false
			registration.dispose()
		}

		let guard: { cancel(): void }
		try {
			this.ownInvocationCleanup(owner)
			guard = owner.effects.defer(cleanup, { tag: `Command:${registration.name}` })
		} catch (error) {
			cleanup()
			throw error
		}

		return Object.freeze({
			name: registration.name,
			dispose() {
				guard.cancel()
				cleanup()
			},
		})
	}

	private ownInvocationCleanup(owner: CoreContext): void {
		if (this.ownsInvocationCleanup) return
		owner.effects.defer(() => closeOwnerInvocations(owner), {
			tag: 'CommandInvocations',
			phase: 'shutdown',
		})
		this.ownsInvocationCleanup = true
	}
}

function bindCommandOwner(owner: CoreContext, command: AnyCommand): AnyCommand {
	const executeOrThrow = async (candidate: unknown, context?: CommandContext): Promise<unknown> => {
		let lease
		try {
			lease = enterOwnerInvocation(owner, context?.signal)
		} catch (error) {
			throw cancellationError(error)
		}
		try {
			return await command.executeOrThrow(candidate, {
				...context,
				signal: lease.signal,
			})
		} finally {
			lease.dispose()
		}
	}

	return {
		name: command.name,
		descriptor: command.descriptor,
		executeOrThrow,
		async execute(candidate: unknown, context?: CommandContext): Promise<CommandResult<unknown>> {
			try {
				return { ok: true, value: await executeOrThrow(candidate, context) }
			} catch (error) {
				return {
					ok: false,
					error:
						error instanceof CommandError
							? error
							: new CommandError('INTERNAL', 'Command failed', { cause: error }),
				}
			}
		},
	}
}

function cancellationError(error: unknown): CommandError {
	return error instanceof CommandError
		? error
		: new CommandError('ABORTED', 'Command cancelled', { cause: error })
}

/** @internal Keep the owner-bearing Commands view isolated per plugin Context. */
export function withCommandsPluginContext<T extends CoreContext.Config>(config: T): T {
	const registry =
		config.registry && typeof config.registry === 'object'
			? (config.registry as Record<string, unknown>)
			: {}
	const current = Array.isArray(registry.pluginCTXIsolate)
		? (registry.pluginCTXIsolate as unknown[])
		: []
	if (current.includes(CommandsService)) return config
	return {
		...config,
		registry: {
			...registry,
			pluginCTXIsolate: [...current, CommandsService],
		},
	} as T
}

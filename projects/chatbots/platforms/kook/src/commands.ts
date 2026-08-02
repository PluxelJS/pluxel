import {
	CommandError,
	defineCommand,
	type Command,
	type CommandContext,
	type ObjectSchema,
	type Registration,
	type VoidCommandDefinition,
	type Wire,
} from '@pluxel/commands'
import {
	createArgvRouter,
	type ArgvBinding,
	type ArgvCommandDescriptor,
} from '@pluxel/commands/argv'
import {
	closeOwnerInvocations,
	enterOwnerInvocation,
	type OwnerInvocationLease,
} from '@pluxel/core/internal'
import type { Context } from '@pluxel/runtime'
import type { KookBot } from './bot/bot.ts'
import type { KookEvent } from './bot/events.types.ts'
import { MessageType } from './types/base.ts'

export interface KookCommandContext extends CommandContext {
	readonly carrier: 'kook'
	/** Aborted when the gateway call, KOOK provider, or registering plugin stops. */
	readonly signal: AbortSignal
	readonly bot: KookBot
	readonly event: KookEvent
	/** Reply to the invoking message and return the created KOOK message ID. */
	reply(content: string): Promise<string>
}

const kookCommandBrand = Symbol('KookCommand')

/** A KOOK-native command whose handler owns all user responses and returns no public output. */
export type KookCommand<Input = unknown> = Command<Input, void, KookCommandContext> & {
	readonly [kookCommandBrand]: true
}

/**
 * Define a KOOK-native command. Its handler receives `KookCommandContext`, replies directly, and
 * returns no structured output. Use `defineCommand()` plus `kook.commands.bind()` for a portable
 * command whose output needs a KOOK projection.
 */
export function defineKookCommand<SIn extends ObjectSchema>(
	config: VoidCommandDefinition<SIn, KookCommandContext>,
): KookCommand<Wire<SIn>> {
	if (Object.hasOwn(config, 'output')) {
		throw new TypeError(
			'defineKookCommand() does not accept output; use defineCommand() and kook.commands.bind()',
		)
	}
	const command = defineCommand<SIn, KookCommandContext>(config)
	Object.defineProperty(command, kookCommandBrand, { value: true })
	return command as KookCommand<Wire<SIn>>
}

type KookContextProjection<CommandCtx extends CommandContext> = CommandContext extends CommandCtx
	? { context?: never }
	: { context(source: KookCommandContext): CommandCtx }

/** KOOK syntax, invocation-context mapping, and terminal response projection for a Command. */
export type KookCommandProjection<
	Input,
	Output,
	CommandCtx extends CommandContext = CommandContext,
> = ArgvBinding<Input> &
	KookContextProjection<CommandCtx> & {
		respond(output: Output, context: KookCommandContext): void | Promise<void>
		/** Return a safe terminal message for a command-specific failure, or defer to the carrier. */
		presentError?(error: unknown, context: KookCommandContext): string | undefined
	}

/**
 * Owner-bound KOOK command routes.
 *
 * Manual registration disposal only withdraws the route, so an already admitted invocation may
 * finish. Stopping its owner aborts and drains admitted invocations before owner teardown.
 */
export interface KookCommands {
	/**
	 * Register a KOOK-native command; its execute handler owns the response.
	 *
	 * The route belongs to the calling plugin and is withdrawn when that plugin stops.
	 */
	register<Input>(command: KookCommand<Input>, binding: ArgvBinding<Input>): Registration
	/**
	 * Bind a portable Command and project its validated output to KOOK.
	 *
	 * The route belongs to the calling plugin and is withdrawn when that plugin stops.
	 */
	bind<Input, Output, Context extends CommandContext>(
		command: Command<Input, Output, Context>,
		projection: KookCommandProjection<Input, Output, Context>,
	): Registration
	list(): readonly ArgvCommandDescriptor[]
}

type ActiveBinding = {
	owner: Context
	execute(candidate: unknown, context: KookCommandContext): Promise<unknown>
	respond: ((output: unknown, context: KookCommandContext) => void | Promise<void>) | undefined
	presentError: ((error: unknown, context: KookCommandContext) => string | undefined) | undefined
	dispose(): void
}

/** @internal KOOK owns parsing and constructs the context required by its command registry. */
export class KookCommandCarrier {
	private readonly router = createArgvRouter<KookCommandContext>()
	private readonly bindings = new Map<string, ActiveBinding>()
	private readonly views = new WeakMap<Context, KookCommands>()
	private readonly ownersWithInvocationCleanup = new WeakSet<Context>()
	private readonly prefix: () => string
	private active = true

	constructor(
		private readonly ctx: Context,
		prefix: string | (() => string) = '/',
	) {
		this.prefix = typeof prefix === 'function' ? prefix : () => prefix
	}

	/** @internal Return one stable owner-bound author view. */
	forOwner(owner: Context): KookCommands {
		if (owner.root !== this.ctx.root) {
			throw new TypeError('KOOK command owner must belong to the carrier runtime')
		}
		let view = this.views.get(owner)
		if (view) return view
		view = Object.freeze({
			register: <Input>(command: KookCommand<Input>, binding: ArgvBinding<Input>) =>
				this.register(owner, command, binding),
			bind: <Input, Output, CommandCtx extends CommandContext>(
				command: Command<Input, Output, CommandCtx>,
				projection: KookCommandProjection<Input, Output, CommandCtx>,
			) => this.bind(owner, command, projection),
			list: () => this.list(),
		})
		this.views.set(owner, view)
		return view
	}

	list(): readonly ArgvCommandDescriptor[] {
		return this.router.list()
	}

	async dispatch(bot: KookBot, event: KookEvent, signal: AbortSignal): Promise<boolean> {
		const source = commandSource(bot, event, this.prefix())
		if (source === undefined) return false
		let context: KookCommandContext | undefined
		let binding: ActiveBinding | undefined

		try {
			const resolution = this.router.resolve(source)
			if (!resolution) return false
			binding = this.bindings.get(resolution.command.name)!
			let carrierLease: OwnerInvocationLease | undefined
			let ownerLease: OwnerInvocationLease | undefined
			try {
				carrierLease = enterInvocation(this.ctx, signal)
				ownerLease =
					binding.owner === this.ctx
						? carrierLease
						: enterInvocation(binding.owner, carrierLease.signal)
				context = createKookCommandContext(bot, event, ownerLease.signal)
				const output = await binding.execute(resolution.candidate, context)
				await binding.respond?.(output, context)
				return true
			} finally {
				if (ownerLease && ownerLease !== carrierLease) ownerLease.dispose()
				carrierLease?.dispose()
			}
		} catch (error) {
			if (signal.aborted) throw signal.reason ?? error
			if (context?.signal.aborted || isCancellation(error)) return true
			context ??= createKookCommandContext(bot, event, signal)
			const presented = binding?.presentError?.(error, context)
			if (presented !== undefined) {
				await context.reply(presented)
				return true
			}
			await this.reportFailure(error, context)
			return true
		}
	}

	dispose(): void {
		if (!this.active) return
		this.active = false
		for (const binding of this.bindings.values()) binding.dispose()
	}

	private register<Input>(
		owner: Context,
		command: KookCommand<Input>,
		binding: ArgvBinding<Input>,
	): Registration {
		if (!isKookCommand(command)) {
			throw new TypeError('commands.register() requires a command from defineKookCommand()')
		}
		if (Object.hasOwn(binding, 'respond')) {
			throw new TypeError(
				'KOOK-native commands respond inside execute(); binding.respond is invalid',
			)
		}
		return this.install(
			owner,
			command,
			binding,
			(candidate, context) => command.executeOrThrow(candidate, context),
			undefined,
			undefined,
		)
	}

	private bind<Input, Output, CommandCtx extends CommandContext>(
		owner: Context,
		command: Command<Input, Output, CommandCtx>,
		projection: KookCommandProjection<Input, Output, CommandCtx>,
	): Registration {
		if (isKookCommand(command)) {
			throw new TypeError('commands.bind() accepts portable commands; use commands.register()')
		}
		if (typeof projection.respond !== 'function') {
			throw new TypeError('commands.bind() requires a respond function')
		}
		const { respond, presentError, context: projectContext, ...binding } = projection
		return this.install(
			owner,
			command,
			binding,
			(candidate, context) =>
				command.executeOrThrow(
					candidate,
					(projectContext ? projectContext(context) : context) as CommandCtx,
				),
			respond,
			presentError,
		)
	}

	private install<Input, Output, CommandCtx extends CommandContext>(
		owner: Context,
		command: Command<Input, Output, CommandCtx>,
		binding: ArgvBinding<Input>,
		execute: (candidate: unknown, context: KookCommandContext) => Promise<Output>,
		respond?: (output: Output, context: KookCommandContext) => void | Promise<void>,
		presentError?: (error: unknown, context: KookCommandContext) => string | undefined,
	): Registration {
		this.assertActive()
		const registration = this.router.bind(
			command as unknown as Command<Input, Output, KookCommandContext>,
			binding,
		)
		let published = true
		let guard: { cancel(): void } | undefined
		let active!: ActiveBinding
		const cleanup = () => {
			if (!published) return
			published = false
			if (this.bindings.get(command.name) === active) this.bindings.delete(command.name)
			registration.dispose()
		}
		active = {
			owner,
			execute,
			respond: respond as
				| ((output: unknown, context: KookCommandContext) => void | Promise<void>)
				| undefined,
			presentError,
			dispose: () => {
				guard?.cancel()
				cleanup()
			},
		}
		this.bindings.set(command.name, active)
		try {
			this.ownInvocationCleanup(owner)
			guard = owner.effects.defer(cleanup, { tag: `KookCommand:${command.name}` })
		} catch (error) {
			cleanup()
			throw error
		}
		return Object.freeze({ name: command.name, dispose: active.dispose })
	}

	private ownInvocationCleanup(owner: Context): void {
		if (this.ownersWithInvocationCleanup.has(owner)) return
		owner.effects.defer(() => closeOwnerInvocations(owner), {
			tag: 'KookCommandInvocations',
			phase: 'shutdown',
		})
		this.ownersWithInvocationCleanup.add(owner)
	}

	private async reportFailure(error: unknown, context: KookCommandContext): Promise<void> {
		if (error instanceof CommandError && error.kind === 'expected') {
			await context.reply(error.publicMessage)
			return
		}
		this.ctx.logger.warn('KOOK command failed', {
			accountId: context.bot.id,
			error,
		})
		await context.reply('命令执行失败，请稍后重试。')
	}

	private assertActive(): void {
		if (!this.active) throw new Error('KOOK command carrier is stopped')
	}
}

function isKookCommand(command: object): boolean {
	return (command as { [kookCommandBrand]?: unknown })[kookCommandBrand] === true
}

function enterInvocation(owner: Context, signal: AbortSignal): OwnerInvocationLease {
	try {
		return enterOwnerInvocation(owner, signal)
	} catch (error) {
		throw new CommandError('ABORTED', 'Command cancelled', { cause: error })
	}
}

function isCancellation(error: unknown): boolean {
	return error instanceof CommandError && error.code === 'ABORTED'
}

function commandSource(bot: KookBot, event: KookEvent, prefix: string): string | undefined {
	if (event.type !== MessageType.text && event.type !== MessageType.kmarkdown) return undefined
	if (event.author_id === bot.selfInfo?.id || event.extra?.author?.bot) return undefined
	const text = (event.extra?.kmarkdown?.raw_content ?? event.content ?? '').trimStart()
	if (!text.startsWith(prefix)) return undefined
	const source = text.slice(prefix.length).trim()
	return source || undefined
}

function createKookCommandContext(
	bot: KookBot,
	event: KookEvent,
	signal: AbortSignal,
): KookCommandContext {
	return Object.freeze({
		carrier: 'kook' as const,
		signal,
		bot,
		event,
		reply: async (content: string) => {
			signal.throwIfAborted()
			const result =
				event.channel_type === 'PERSON'
					? await bot.$.raw.call(
							'createDirectMessage',
							{ target_id: event.author_id, quote: event.msg_id, content },
							{ signal },
						)
					: await bot.$.raw.call(
							'sendMessage',
							{ target_id: event.target_id, quote: event.msg_id, content },
							{ signal },
						)
			signal.throwIfAborted()
			if (result.ok === false) {
				throw new Error(`KOOK API error ${result.code}: ${result.message}`)
			}
			return result.data.msg_id
		},
	})
}

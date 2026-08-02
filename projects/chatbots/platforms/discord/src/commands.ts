import {
	CommandError,
	type Command,
	type CommandContext,
	type Registration,
} from '@pluxel/commands'
import {
	closeOwnerInvocations,
	enterOwnerInvocation,
	type OwnerInvocationLease,
} from '@pluxel/core/internal'
import type { Context } from '@pluxel/runtime'
import {
	SlashCommandBuilder,
	type ChatInputCommandInteraction,
	type RESTPostAPIChatInputApplicationCommandsJSONBody,
	type SlashCommandSubcommandBuilder,
} from 'discord.js'
import type { DiscordBot, DiscordMessage } from './protocol.ts'

export interface DiscordCommandSource extends CommandContext {
	readonly carrier: 'discord'
	readonly signal: AbortSignal
	readonly bot: DiscordBot
	readonly guildId: string
	readonly channelId: string
	readonly user: Readonly<{ id: string; displayName: string; avatarUrl?: string }>
	readonly interaction: ChatInputCommandInteraction
	respond(message: string | DiscordMessage): Promise<void>
	responded(): boolean
}

type DiscordContextProjection<Ctx extends CommandContext> = CommandContext extends Ctx
	? { context?: never }
	: { context(source: DiscordCommandSource): Ctx }

export type DiscordCommandProjection<
	Input,
	Output,
	Ctx extends CommandContext,
> = DiscordContextProjection<Ctx> & {
	root: Readonly<{ name: string; description: string }>
	subcommand: Readonly<{
		name: string
		description: string
		configure?(builder: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder
	}>
	input(source: DiscordCommandSource): Input
	respond(output: Output, source: DiscordCommandSource): void | Promise<void>
	presentError?(error: unknown, source: DiscordCommandSource): string | undefined
}

export interface DiscordCommands {
	bind<Input, Output, Ctx extends CommandContext>(
		command: Command<Input, Output, Ctx>,
		projection: DiscordCommandProjection<Input, Output, Ctx>,
	): Registration
	list(): readonly RESTPostAPIChatInputApplicationCommandsJSONBody[]
}

export type DiscordCommandCatalogSnapshot = Readonly<{
	revision: number
	definitions: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[]
}>

type ActiveBinding = Readonly<{
	owner: Context
	root: Readonly<{ name: string; description: string }>
	subcommand: DiscordCommandProjection<unknown, unknown, CommandContext>['subcommand']
	input(source: DiscordCommandSource): unknown
	execute(candidate: unknown, source: DiscordCommandSource): Promise<unknown>
	respond(output: unknown, source: DiscordCommandSource): void | Promise<void>
	presentError?: (error: unknown, source: DiscordCommandSource) => string | undefined
	dispose(): void
}>

export class DiscordCommandCarrier {
	private readonly bindings = new Map<string, ActiveBinding>()
	private readonly views = new WeakMap<Context, DiscordCommands>()
	private readonly ownersWithInvocationCleanup = new WeakSet<Context>()
	private revision = 0
	private snapshotCache?: DiscordCommandCatalogSnapshot
	private active = true

	constructor(
		private readonly ctx: Context,
		private readonly onChanged: () => void = () => undefined,
	) {}

	forOwner(owner: Context): DiscordCommands {
		if (owner.root !== this.ctx.root) {
			throw new TypeError('Discord command owner must belong to the carrier runtime')
		}
		let view = this.views.get(owner)
		if (view) return view
		view = Object.freeze({
			bind: <Input, Output, Ctx extends CommandContext>(
				command: Command<Input, Output, Ctx>,
				projection: DiscordCommandProjection<Input, Output, Ctx>,
			) => this.bind(owner, command, projection),
			list: () => this.list(),
		})
		this.views.set(owner, view)
		return view
	}

	list(): readonly RESTPostAPIChatInputApplicationCommandsJSONBody[] {
		return this.snapshot().definitions
	}

	snapshot(): DiscordCommandCatalogSnapshot {
		if (this.snapshotCache) return this.snapshotCache
		const groups = new Map<string, ActiveBinding[]>()
		for (const binding of this.bindings.values()) {
			const group = groups.get(binding.root.name)
			if (group) group.push(binding)
			else groups.set(binding.root.name, [binding])
		}
		const definitions = Object.freeze(
			[...groups.values()]
				.sort(([left], [right]) => left!.root.name.localeCompare(right!.root.name))
				.map((bindings) => {
					const root = bindings[0]!.root
					const builder = new SlashCommandBuilder()
						.setName(root.name)
						.setDescription(root.description)
					for (const binding of bindings.toSorted((left, right) =>
						left.subcommand.name.localeCompare(right.subcommand.name),
					)) {
						builder.addSubcommand((subcommand) => {
							const configured = subcommand
								.setName(binding.subcommand.name)
								.setDescription(binding.subcommand.description)
							return binding.subcommand.configure?.(configured) ?? configured
						})
					}
					return builder.toJSON()
				}),
		)
		return (this.snapshotCache = Object.freeze({ revision: this.revision, definitions }))
	}

	async dispatch(source: DiscordCommandSource): Promise<boolean> {
		const key = routeKey(
			source.interaction.commandName,
			source.interaction.options.getSubcommand(true),
		)
		const binding = this.bindings.get(key)
		if (!binding) return false
		let carrierLease: OwnerInvocationLease | undefined
		let ownerLease: OwnerInvocationLease | undefined
		try {
			carrierLease = enterInvocation(this.ctx, source.signal)
			ownerLease =
				binding.owner === this.ctx
					? carrierLease
					: enterInvocation(binding.owner, carrierLease.signal)
			const scopedSource = Object.freeze({ ...source, signal: ownerLease.signal })
			const output = await binding.execute(binding.input(scopedSource), scopedSource)
			await binding.respond(output, scopedSource)
			return true
		} catch (error) {
			if (source.signal.aborted) throw source.signal.reason ?? error
			if (ownerLease?.signal.aborted || isCancellation(error)) return true
			const presented = binding.presentError?.(error, source)
			if (presented !== undefined) await source.respond(presented)
			else await this.reportFailure(error, source)
			return true
		} finally {
			if (ownerLease && ownerLease !== carrierLease) ownerLease.dispose()
			carrierLease?.dispose()
		}
	}

	dispose(): void {
		if (!this.active) return
		this.active = false
		for (const binding of this.bindings.values()) binding.dispose()
	}

	private bind<Input, Output, Ctx extends CommandContext>(
		owner: Context,
		command: Command<Input, Output, Ctx>,
		projection: DiscordCommandProjection<Input, Output, Ctx>,
	): Registration {
		this.assertActive()
		const key = routeKey(projection.root.name, projection.subcommand.name)
		if (this.bindings.has(key)) throw new Error(`Discord command route is already bound: ${key}`)
		for (const existing of this.bindings.values()) {
			if (
				existing.root.name === projection.root.name &&
				existing.root.description !== projection.root.description
			) {
				throw new Error(
					`Discord command root has conflicting descriptions: ${projection.root.name}`,
				)
			}
		}
		let published = true
		let guard: { cancel(): void } | undefined
		let active!: ActiveBinding
		const cleanup = () => {
			if (!published) return
			published = false
			if (this.bindings.get(key) === active) {
				this.bindings.delete(key)
				this.publishChanged()
			}
		}
		active = {
			owner,
			root: projection.root,
			subcommand: projection.subcommand,
			input: projection.input,
			execute: (candidate, source) =>
				command.executeOrThrow(
					candidate,
					(projection.context ? projection.context(source) : source) as Ctx,
				),
			respond: projection.respond as ActiveBinding['respond'],
			...(projection.presentError ? { presentError: projection.presentError } : {}),
			dispose: () => {
				guard?.cancel()
				cleanup()
			},
		}
		this.bindings.set(key, active)
		this.publishChanged()
		try {
			this.ownInvocationCleanup(owner)
			guard = owner.effects.defer(cleanup, { tag: `DiscordCommand:${command.name}` })
		} catch (error) {
			cleanup()
			throw error
		}
		return Object.freeze({ name: command.name, dispose: active.dispose })
	}

	private ownInvocationCleanup(owner: Context): void {
		if (this.ownersWithInvocationCleanup.has(owner)) return
		owner.effects.defer(() => closeOwnerInvocations(owner), {
			tag: 'DiscordCommandInvocations',
			phase: 'shutdown',
		})
		this.ownersWithInvocationCleanup.add(owner)
	}

	private async reportFailure(error: unknown, source: DiscordCommandSource): Promise<void> {
		if (error instanceof CommandError && error.kind === 'expected') {
			await source.respond(error.publicMessage)
			return
		}
		this.ctx.logger.warn('Discord command failed', { botId: source.bot.id, error })
		await source.respond('命令执行失败，请稍后重试。')
	}

	private assertActive(): void {
		if (!this.active) throw new Error('Discord command carrier is stopped')
	}

	private publishChanged(): void {
		this.revision += 1
		this.snapshotCache = undefined
		this.onChanged()
	}
}

function routeKey(root: string, subcommand: string): string {
	return `${root}:${subcommand}`
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

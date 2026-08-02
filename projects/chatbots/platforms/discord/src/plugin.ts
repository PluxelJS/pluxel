import { BasePlugin, Plugin, v } from '@pluxel/runtime'
import type { VaultServiceConfig as _VaultServiceConfig } from '@pluxel/runtime/services/vault'
import { workbench } from '@pluxel/runtime/workbench'
import { BotAccountStore, type BotAccountConfig } from '@repo/chatbots-platform-kit/account-store'
import { KeyedSerialExecutor } from '@repo/chatbots-platform-kit/keyed-serial'
import { maskBotSecret } from '@repo/chatbots-platform-kit/bot-admin'
import {
	createBotRegistry,
	normalizeBotId,
	type BotRegistryController,
} from '@repo/chatbots-platform-kit/registry'
import {
	ActivityType,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	Client,
	Events,
	GatewayIntentBits,
	MessageFlags,
	Options,
	type ChatInputCommandInteraction,
	type ButtonInteraction,
} from 'discord.js'
import { DiscordCommandCarrier, type DiscordCommands } from './commands.ts'
import type {
	DiscordActivity,
	DiscordBot,
	DiscordBotConfigInput,
	DiscordBotDirectory,
	DiscordBotSnapshot,
	DiscordInteractionConsumer,
	DiscordInteractionContext,
	DiscordMessage,
	DiscordVoiceHuman,
	DiscordVoiceTarget,
} from './protocol.ts'
import type { DiscordAdminAccount, DiscordAdminEvents } from './workbench/contract.ts'
import { DiscordWorkbench } from './workbench/extension.ts'
import { attachDiscordAdminState, DiscordWorkbenchRpc } from './workbench/service.ts'

const VAULT_NAMESPACE = 'DiscordPlugin'
const DEFAULT_API_BASE = 'https://discord.com/api/v10'

const DiscordClientConfig = v.object({
	commandGuildIds: v.optional(
		v.pipe(v.array(v.pipe(v.string(), v.regex(/^\d{17,20}$/))), v.maxLength(100)),
		[],
	),
	readyTimeoutMs: v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(1_000), v.maxValue(120_000)),
		20_000,
	),
})

@Plugin({ name: 'DiscordPlugin', startTimeoutMs: 30_000 })
export class DiscordPlugin extends BasePlugin {
	private readonly config = this.configs.use(DiscordClientConfig)
	private readonly interactionConsumers = new Map<string, DiscordInteractionConsumer>()
	private readonly commandCarrier = new DiscordCommandCarrier(this.ctx, () =>
		this.scheduleCommandSync(),
	)
	private manager?: DiscordBotManager
	private commandSyncScheduled = false

	get commands(): DiscordCommands {
		return this.commandCarrier.forOwner(this.ctx.caller ?? this.ctx)
	}

	get bots(): DiscordBotDirectory {
		return this.ready().bots
	}

	override async init(): Promise<void> {
		this.ctx.effects.own(this.commandCarrier, { tag: 'DiscordCommands' })
		const manager = new DiscordBotManager({
			accounts: new BotAccountStore(
				this.ctx.vault.namespace(VAULT_NAMESPACE).kv(),
				DEFAULT_API_BASE,
			),
			commandGuildIds: this.config.commandGuildIds,
			readyTimeoutMs: this.config.readyTimeoutMs,
			commandDefinitions: () => this.commandCarrier.list(),
			dispatchCommand: (context) => this.commandCarrier.dispatch(context),
			buttonPrefixes: () => [...this.interactionConsumers.keys()],
			onInteraction: (context) => this.dispatchInteraction(context),
			flushVault: () => this.ctx.vault.flush(),
			onError: (error, botId) =>
				this.ctx.logger.warn('Discord bot operation failed', { error, botId }),
		})
		this.manager = manager
		this.ctx.effects.defer(async () => {
			this.interactionConsumers.clear()
			await manager.dispose()
			if (this.manager === manager) this.manager = undefined
		})
		await manager.start()
		if (this.ctx.workbench.enabled) {
			this.ctx.workbench.mount(DiscordWorkbench, {
				commands: workbench.bind.rpc(() => new DiscordWorkbenchRpc(this)),
				state: workbench.bind.events<DiscordAdminEvents>((events) =>
					attachDiscordAdminState(this, events),
				),
			})
		}
		this.ctx.http.plugin.routes(
			(app) =>
				app.get('/health', () => {
					const bots = manager.bots.list()
					return {
						ok: bots.every((bot) => bot.state !== 'failed'),
						bots,
					}
				}),
			{ path: '/api', id: 'DiscordPlugin:api' },
		)
	}

	registerInteractionConsumer(
		customIdPrefix: string,
		consumer: DiscordInteractionConsumer,
	): () => void {
		if (!customIdPrefix) throw new TypeError('Discord interaction prefix must not be empty')
		if (this.interactionConsumers.has(customIdPrefix)) {
			throw new Error(`Discord interaction prefix is already registered: ${customIdPrefix}`)
		}
		this.interactionConsumers.set(customIdPrefix, consumer)
		return () => {
			if (this.interactionConsumers.get(customIdPrefix) === consumer) {
				this.interactionConsumers.delete(customIdPrefix)
			}
		}
	}

	upsertBot(input: DiscordBotConfigInput): Promise<DiscordBot> {
		return this.ready().upsert(input)
	}

	removeBot(id: string): Promise<void> {
		return this.ready().remove(id)
	}

	reconnectBot(id: string): Promise<DiscordBotSnapshot> {
		return this.ready().reconnect(id)
	}

	disconnectBot(id: string): Promise<DiscordBotSnapshot> {
		return this.ready().disconnect(id)
	}

	adminAccounts(): DiscordAdminAccount[] {
		return this.ready().adminAccounts()
	}

	observeAdmin(observer: () => void): () => void {
		return this.ready().observe(observer)
	}

	private scheduleCommandSync(): void {
		if (this.commandSyncScheduled) return
		this.commandSyncScheduled = true
		queueMicrotask(() => {
			this.commandSyncScheduled = false
			void this.manager
				?.syncCommands()
				.catch((error: unknown) =>
					this.ctx.logger.warn('Discord command synchronization failed', { error }),
				)
		})
	}

	private dispatchInteraction(
		context: Extract<DiscordInteractionContext, Readonly<{ kind: 'button' }>>,
	): void | Promise<void> {
		const match = [...this.interactionConsumers.entries()]
			.filter(([prefix]) => context.customId.startsWith(prefix))
			.toSorted(([left], [right]) => right.length - left.length)[0]
		return match?.[1](context)
	}

	private ready(): DiscordBotManager {
		if (!this.manager) throw new Error('DiscordPlugin is not running')
		return this.manager
	}
}

type DiscordBotManagerOptions = Readonly<{
	accounts: BotAccountStore
	commandGuildIds: readonly string[]
	readyTimeoutMs: number
	commandDefinitions(): readonly import('discord.js').RESTPostAPIChatInputApplicationCommandsJSONBody[]
	dispatchCommand(context: import('./commands.ts').DiscordCommandSource): Promise<boolean>
	buttonPrefixes(): readonly string[]
	onInteraction(
		context: Extract<DiscordInteractionContext, Readonly<{ kind: 'button' }>>,
	): void | Promise<void>
	flushVault(): Promise<void>
	onError(error: unknown, botId: string): void
}>

class DiscordBotManager {
	private readonly registryState = createBotRegistry<ManagedDiscordBot>({
		onObserverError: (error) => this.options.onError(error, 'registry'),
	})
	private readonly registryController: BotRegistryController<ManagedDiscordBot> =
		this.registryState.controller
	private readonly disposers = new Map<string, () => void>()
	private readonly configs = new Map<string, BotAccountConfig>()
	private readonly mutations = new KeyedSerialExecutor<string>()
	private readonly listeners = new Set<() => void>()
	private disposed = false

	readonly bots: DiscordBotDirectory = {
		list: () => [...this.registryState.registry.values()].map((bot) => bot.snapshot()),
		get: (id) => this.registryState.registry.get(id),
		observe: (observer) => {
			this.listeners.add(observer)
			return () => this.listeners.delete(observer)
		},
	}

	constructor(private readonly options: DiscordBotManagerOptions) {}

	adminAccounts(): DiscordAdminAccount[] {
		return [...this.configs.values()]
			.map((config) => {
				const snapshot = this.registryState.registry.require(config.id).snapshot()
				return Object.assign(
					{
						id: config.id,
						tokenPreview: maskBotSecret(config.token),
						state: snapshot.state,
						guilds: snapshot.guilds,
						epoch: snapshot.epoch,
					},
					snapshot.username ? { username: snapshot.username } : {},
					snapshot.applicationId ? { applicationId: snapshot.applicationId } : {},
					snapshot.connectedAt ? { connectedAt: snapshot.connectedAt } : {},
					snapshot.lastHealthyAt ? { lastHealthyAt: snapshot.lastHealthyAt } : {},
					snapshot.failureMessage ? { failureMessage: snapshot.failureMessage } : {},
				)
			})
			.toSorted((left, right) => left.id.localeCompare(right.id))
	}

	observe(observer: () => void): () => void {
		this.listeners.add(observer)
		return () => this.listeners.delete(observer)
	}

	async start(): Promise<void> {
		for (const id of await this.options.accounts.list()) {
			const config = await this.options.accounts.read(id)
			if (!config) continue
			const bot = this.install(config)
			void bot.start().catch((error: unknown) => this.options.onError(error, id))
		}
	}

	async upsert(input: DiscordBotConfigInput): Promise<DiscordBot> {
		const id = normalizeBotId(input.id)
		return this.mutations.run(id, async () => {
			this.assertActive()
			const config = await this.options.accounts.upsert({ id, token: input.token })
			await this.options.flushVault()
			const bot = this.install(config)
			await bot.start()
			return bot
		})
	}

	async remove(idInput: string): Promise<void> {
		const id = normalizeBotId(idInput)
		await this.mutations.run(id, async () => {
			this.assertActive()
			await this.options.accounts.remove(id)
			await this.options.flushVault()
			this.uninstall(id)
		})
	}

	reconnect(idInput: string): Promise<DiscordBotSnapshot> {
		const id = normalizeBotId(idInput)
		return this.mutations.run(id, async () => {
			this.assertActive()
			return this.registryState.registry.require(id).start()
		})
	}

	disconnect(idInput: string): Promise<DiscordBotSnapshot> {
		const id = normalizeBotId(idInput)
		return this.mutations.run(id, async () => {
			this.assertActive()
			return this.registryState.registry.require(id).stop()
		})
	}

	async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		await Promise.allSettled([...this.registryState.registry.values()].map((bot) => bot.stop()))
		for (const id of this.registryState.registry.keys()) this.uninstall(id)
		this.configs.clear()
		this.listeners.clear()
	}

	async syncCommands(): Promise<void> {
		await Promise.all([...this.registryState.registry.values()].map((bot) => bot.refreshCommands()))
	}

	private install(config: BotAccountConfig): ManagedDiscordBot {
		this.uninstall(config.id)
		const bot = new ManagedDiscordBot(config, {
			commandGuildIds: this.options.commandGuildIds,
			readyTimeoutMs: this.options.readyTimeoutMs,
			commandDefinitions: this.options.commandDefinitions,
			dispatchCommand: this.options.dispatchCommand,
			buttonPrefixes: this.options.buttonPrefixes,
			onInteraction: this.options.onInteraction,
			onChanged: () => this.publish(),
			onError: (error) => this.options.onError(error, config.id),
		})
		this.configs.set(config.id, config)
		this.disposers.set(config.id, this.registryController.register(config.id, bot))
		this.publish()
		return bot
	}

	private uninstall(id: string): void {
		this.registryState.registry.get(id)?.destroy()
		this.disposers.get(id)?.()
		this.disposers.delete(id)
		this.configs.delete(id)
		this.publish()
	}

	private publish(): void {
		for (const listener of this.listeners) {
			try {
				listener()
			} catch (error) {
				this.options.onError(error, 'observer')
			}
		}
	}

	private assertActive(): void {
		if (this.disposed) throw new Error('Discord bot manager is stopped')
	}
}

type ManagedDiscordBotOptions = Readonly<{
	commandGuildIds: readonly string[]
	readyTimeoutMs: number
	commandDefinitions(): readonly import('discord.js').RESTPostAPIChatInputApplicationCommandsJSONBody[]
	dispatchCommand(context: import('./commands.ts').DiscordCommandSource): Promise<boolean>
	buttonPrefixes(): readonly string[]
	onInteraction(
		context: Extract<DiscordInteractionContext, Readonly<{ kind: 'button' }>>,
	): void | Promise<void>
	onChanged(): void
	onError(error: unknown): void
}>

class ManagedDiscordBot implements DiscordBot {
	private client?: Client
	private epoch = 0
	private state: DiscordBotSnapshot['state'] = 'stopped'
	private connectedAt?: number
	private lastHealthyAt?: number
	private failureMessage?: string
	private operation?: Promise<DiscordBotSnapshot>
	private eventController?: AbortController

	readonly id: string

	constructor(
		private readonly config: BotAccountConfig,
		private readonly options: ManagedDiscordBotOptions,
	) {
		this.id = config.id
	}

	snapshot(): DiscordBotSnapshot {
		const user = this.client?.user
		return {
			id: this.id,
			state: this.state,
			epoch: this.epoch,
			...(this.client?.application?.id ? { applicationId: this.client.application.id } : {}),
			...(user?.id ? { userId: user.id } : {}),
			...(user?.username ? { username: user.username } : {}),
			guilds: this.client?.guilds.cache.size ?? 0,
			...(this.connectedAt === undefined ? {} : { connectedAt: this.connectedAt }),
			...(this.lastHealthyAt === undefined ? {} : { lastHealthyAt: this.lastHealthyAt }),
			...(this.failureMessage === undefined ? {} : { failureMessage: this.failureMessage }),
		}
	}

	start(): Promise<DiscordBotSnapshot> {
		if (this.operation) return this.operation
		const operation = this.startNow().finally(() => {
			if (this.operation === operation) this.operation = undefined
		})
		this.operation = operation
		return operation
	}

	private async startNow(): Promise<DiscordBotSnapshot> {
		this.eventController?.abort('Discord bot reconnecting')
		this.client?.destroy()
		this.epoch += 1
		this.state = 'connecting'
		this.failureMessage = undefined
		const controller = new AbortController()
		this.eventController = controller
		const client = new Client({
			intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
			makeCache: Options.cacheWithLimits({
				MessageManager: 0,
				ReactionManager: 0,
				ReactionUserManager: 0,
				PresenceManager: 0,
			}),
		})
		this.client = client
		client.on(Events.InteractionCreate, (interaction) => {
			if (!interaction.isChatInputCommand() && !interaction.isButton()) return
			if (
				interaction.isButton() &&
				!this.options.buttonPrefixes().some((prefix) => interaction.customId.startsWith(prefix))
			)
				return
			if (
				interaction.isChatInputCommand() &&
				!this.options
					.commandDefinitions()
					.some((command) => command.name === interaction.commandName)
			)
				return
			void this.handleInteraction(interaction, controller.signal)
		})
		client.on(Events.ShardDisconnect, () => {
			if (this.client !== client || this.state === 'stopped') return
			this.state = 'connecting'
			this.options.onChanged()
		})
		client.on(Events.ShardResume, () => {
			if (this.client !== client) return
			this.state = 'ready'
			this.lastHealthyAt = Date.now()
			this.options.onChanged()
		})
		client.on(Events.ShardError, (error) => this.options.onError(error))
		try {
			await withTimeout(client.login(this.config.token), this.options.readyTimeoutMs)
			await this.syncCommands(client)
			if (this.client !== client) throw new Error('Discord client was replaced while connecting')
			this.state = 'ready'
			this.connectedAt = Date.now()
			this.lastHealthyAt = this.connectedAt
			this.options.onChanged()
			return this.snapshot()
		} catch (error) {
			controller.abort(error)
			client.destroy()
			if (this.client === client) {
				this.state = 'failed'
				this.failureMessage = error instanceof Error ? error.message : String(error)
			}
			this.options.onChanged()
			throw error
		}
	}

	async stop(): Promise<DiscordBotSnapshot> {
		this.destroy()
		await this.operation?.catch((): undefined => undefined)
		return this.snapshot()
	}

	destroy(): void {
		this.eventController?.abort('Discord bot stopped')
		this.eventController = undefined
		this.client?.destroy()
		this.client = undefined
		this.state = 'stopped'
		this.options.onChanged()
	}

	async resolveUserVoiceTarget(guildId: string, userId: string): Promise<DiscordVoiceTarget> {
		const client = this.requireReady()
		const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId))
		const member = await guild.members.fetch(userId)
		const channel = member.voice.channel
		if (!channel) throw new Error('请先加入一个 Discord 语音频道。')
		return this.resolveVoiceTarget(guildId, channel.id)
	}

	async resolveVoiceTarget(guildId: string, channelId: string): Promise<DiscordVoiceTarget> {
		const client = this.requireReady()
		const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId))
		const channel = await guild.channels.fetch(channelId)
		if (!channel) throw new Error(`Discord voice channel is unavailable: ${channelId}`)
		if (channel.type !== ChannelType.GuildVoice) {
			throw new Error('Discord Stage 频道暂不支持 Rhythm 播放。')
		}
		return {
			guildId,
			channelId,
			label: channel.name,
			opusBitrateLimitBps: channel.bitrate,
			adapterCreator: guild.voiceAdapterCreator,
		}
	}

	async listVoiceHumans(guildId: string, channelId: string): Promise<readonly DiscordVoiceHuman[]> {
		const client = this.requireReady()
		const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId))
		const channel = await guild.channels.fetch(channelId)
		if (!channel || channel.type !== ChannelType.GuildVoice) {
			throw new Error(`Discord voice channel is unavailable: ${channelId}`)
		}
		return [...channel.members.values()]
			.filter((member) => !member.user.bot)
			.map((member) => {
				const avatarUrl = member.displayAvatarURL()
				return Object.assign(
					{ id: member.id, displayName: member.displayName },
					avatarUrl ? { avatarUrl } : {},
				)
			})
	}

	async sendUserMessage(userId: string, message: string | DiscordMessage): Promise<void> {
		const user = await this.requireReady().users.fetch(userId)
		await user.send(discordMessageOptions(message))
	}

	async sendChannelMessage(
		channelId: string,
		message: DiscordMessage,
	): Promise<Readonly<{ id: string }>> {
		const channel = await this.requireReady().channels.fetch(channelId)
		if (!channel?.isSendable()) throw new Error(`Discord channel is not sendable: ${channelId}`)
		const sent = await channel.send(discordMessageOptions(message))
		return { id: sent.id }
	}

	async editChannelMessage(
		channelId: string,
		messageId: string,
		message: DiscordMessage,
	): Promise<void> {
		const channel = await this.requireReady().channels.fetch(channelId)
		if (!channel?.isSendable()) throw new Error(`Discord channel is not sendable: ${channelId}`)
		await channel.messages.edit(messageId, discordMessageOptions(message))
	}

	setActivity(activity: DiscordActivity | undefined): void {
		const client = this.requireReady()
		client.user.setPresence({
			activities: activity
				? [
						{
							name: activity.name,
							type: activity.type === 'listening' ? ActivityType.Listening : ActivityType.Playing,
						},
					]
				: [],
		})
	}

	async refreshCommands(): Promise<void> {
		if (this.state !== 'ready' || !this.client?.isReady()) return
		await this.syncCommands(this.client)
	}

	private async syncCommands(client: Client): Promise<void> {
		const definitions = this.options.commandDefinitions()
		if (this.options.commandGuildIds.length === 0) {
			if (!client.application) throw new Error('Discord application is unavailable after login')
			const commands = await client.application.commands.fetch()
			for (const definition of definitions) {
				const existing = commands.find((command) => command.name === definition.name)
				if (existing) await client.application.commands.edit(existing.id, definition)
				else await client.application.commands.create(definition)
			}
			return
		}
		await Promise.all(
			this.options.commandGuildIds.map(async (guildId) => {
				const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId))
				const commands = await guild.commands.fetch()
				for (const definition of definitions) {
					const existing = commands.find((command) => command.name === definition.name)
					if (existing) await guild.commands.edit(existing.id, definition)
					else await guild.commands.create(definition)
				}
			}),
		)
	}

	private async handleInteraction(
		interaction: ChatInputCommandInteraction | ButtonInteraction,
		signal: AbortSignal,
	): Promise<void> {
		if (interaction.isChatInputCommand()) {
			if (!interaction.guildId) return
		} else if (!interaction.isButton()) return
		let responded = false
		try {
			await interaction.deferReply({ flags: MessageFlags.Ephemeral })
			const base = {
				id: interaction.id,
				bot: this,
				channelId: interaction.channelId,
				user: {
					id: interaction.user.id,
					displayName: interaction.user.globalName ?? interaction.user.username,
					...(interaction.user.displayAvatarURL()
						? { avatarUrl: interaction.user.displayAvatarURL() }
						: {}),
				},
				signal,
				respond: async (message: string | DiscordMessage) => {
					await interaction.editReply(discordMessageOptions(message))
					responded = true
				},
				responded: () => responded,
			}
			if (interaction.isChatInputCommand()) {
				await this.options.dispatchCommand({
					...base,
					carrier: 'discord',
					guildId: interaction.guildId!,
					interaction,
				})
			} else {
				const context: Extract<DiscordInteractionContext, Readonly<{ kind: 'button' }>> = {
					...base,
					kind: 'button',
					customId: interaction.customId,
					...(interaction.guildId ? { guildId: interaction.guildId } : {}),
				}
				await this.options.onInteraction(context)
			}
			if (!responded) await base.respond('命令没有返回结果。')
		} catch (error) {
			const content = error instanceof Error ? error.message : String(error)
			if (interaction.deferred || interaction.replied)
				await interaction.editReply({ content }).catch((): undefined => undefined)
			else {
				await interaction
					.reply({ content, flags: MessageFlags.Ephemeral })
					.catch((): undefined => undefined)
			}
		}
	}

	private requireReady(): Client<true> {
		if (this.state !== 'ready' || !this.client?.isReady()) {
			throw new Error(`Discord bot is not ready: ${this.id}`)
		}
		return this.client
	}
}

function discordMessageOptions(
	message: string | DiscordMessage,
): Readonly<{ content: string; components: ActionRowBuilder<ButtonBuilder>[] }> {
	const normalized = typeof message === 'string' ? { content: message } : message
	return {
		content: normalized.content,
		components:
			normalized.buttons && normalized.buttons.length > 0
				? [
						new ActionRowBuilder<ButtonBuilder>().addComponents(
							...normalized.buttons.map((button) => {
								const builder = new ButtonBuilder().setLabel(button.label)
								if (button.kind === 'link') {
									return builder.setStyle(ButtonStyle.Link).setURL(button.url)
								}
								return builder
									.setCustomId(button.customId)
									.setStyle(discordButtonStyle(button.style))
							}),
						),
					]
				: [],
	}
}

function discordButtonStyle(style: 'primary' | 'success' | 'danger' | 'secondary'): ButtonStyle {
	if (style === 'success') return ButtonStyle.Success
	if (style === 'danger') return ButtonStyle.Danger
	if (style === 'secondary') return ButtonStyle.Secondary
	return ButtonStyle.Primary
}

async function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number): Promise<Value> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('Discord login timed out')), timeoutMs)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

export type {
	DiscordActivity,
	DiscordBot,
	DiscordBotConfigInput,
	DiscordBotDirectory,
	DiscordBotSnapshot,
	DiscordInteractionConsumer,
	DiscordInteractionContext,
	DiscordVoiceHuman,
	DiscordVoiceTarget,
} from './protocol.ts'

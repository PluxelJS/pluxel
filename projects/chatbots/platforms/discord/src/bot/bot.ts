import type { BotAccountConfig } from '@repo/chatbots-platform-kit/account-store'
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
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type ClientUser,
} from 'discord.js'
import type { DiscordCommandCatalogSnapshot, DiscordCommandSource } from '../commands.ts'
import {
	discordCommandManager,
	reconcileDiscordCommands,
	type DiscordCommandManager,
} from './command-sync.ts'
import type {
	DiscordActivity,
	DiscordBot as DiscordBotCapability,
	DiscordBotExtensions,
	DiscordButtonContext,
	DiscordMessage,
	DiscordVoiceHuman,
	DiscordVoiceTarget,
} from '../protocol.ts'
import {
	createDiscordBotStatus,
	updateDiscordBotStatus,
	type DiscordBotStatus,
} from './status.ts'
import { resolveDiscordRestOptions } from './rest.ts'

export type DiscordBotOptions = Readonly<{
	commandGuildIds: readonly string[]
	readyTimeoutMs: number
	commandCatalog(): DiscordCommandCatalogSnapshot
	dispatchCommand(context: DiscordCommandSource): Promise<boolean>
	matchesInteraction(customId: string): boolean
	dispatchInteraction(context: DiscordButtonContext): Promise<boolean>
	onChanged(): void
	onError(error: unknown): void
}>

export class DiscordBot implements DiscordBotCapability {
	private clientValue?: Client
	private operation?: Promise<DiscordBotStatus>
	private eventController?: AbortController
	private statusValue = createDiscordBotStatus()
	private selfInfoValue?: ClientUser

	readonly id: string
	readonly $: DiscordBotExtensions

	constructor(
		private readonly config: BotAccountConfig,
		private readonly options: DiscordBotOptions,
	) {
		this.id = config.id
		const extensions: DiscordBotExtensions = {
			info: Object.freeze({ id: this.id, apiBase: config.apiBase }),
			status: this.statusValue,
			resolveUserVoiceTarget: (guildId, userId) =>
				this.#resolveUserVoiceTarget(guildId, userId),
			resolveVoiceTarget: (guildId, channelId) => this.#resolveVoiceTarget(guildId, channelId),
			listVoiceHumans: (guildId, channelId) => this.#listVoiceHumans(guildId, channelId),
			sendUserMessage: (userId, message) => this.#sendUserMessage(userId, message),
			sendChannelMessage: (channelId, message) => this.#sendChannelMessage(channelId, message),
			editChannelMessage: (channelId, messageId, message) =>
				this.#editChannelMessage(channelId, messageId, message),
			setActivity: (activity) => this.#setActivity(activity),
			start: () => this.#connect(),
			stop: () => this.#stopConnection(),
			destroy: () => this.#destroy(),
		}
		Object.defineProperty(extensions, 'status', {
			enumerable: true,
			get: () => this.statusValue,
		})
		this.$ = Object.freeze(extensions)
	}

	get selfInfo(): ClientUser | undefined {
		return this.selfInfoValue
	}

	get client(): Client<true> {
		return this.#requireReady()
	}

	#connect(): Promise<DiscordBotStatus> {
		this.#assertAlive()
		if (this.operation) return this.operation
		const operation = this.#startNow().finally(() => {
			if (this.operation === operation) this.operation = undefined
		})
		this.operation = operation
		return operation
	}

	async #startNow(): Promise<DiscordBotStatus> {
		this.eventController?.abort('Discord bot reconnecting')
		this.clientValue?.destroy()
		const epoch = this.statusValue.gateway.epoch + 1
		this.#setStatus('connecting', {
			lastError: null,
			connectedAt: null,
			gateway: { epoch, applicationId: null, guilds: 0, lastHealthyAt: null },
		})
		const controller = new AbortController()
		this.eventController = controller
		const client = new Client({
			intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
			rest: resolveDiscordRestOptions(this.config.apiBase),
			makeCache: Options.cacheWithLimits({
				MessageManager: 0,
				ReactionManager: 0,
				ReactionUserManager: 0,
				PresenceManager: 0,
			}),
		})
		this.clientValue = client
		client.on(Events.InteractionCreate, (interaction) => {
			if (!interaction.isChatInputCommand() && !interaction.isButton()) return
			if (interaction.isButton() && !this.options.matchesInteraction(interaction.customId)) return
			if (
				interaction.isChatInputCommand() &&
				!this.options
					.commandCatalog()
					.definitions.some((command) => command.name === interaction.commandName)
			)
				return
			void this.handleInteraction(interaction, controller.signal)
		})
		client.on(Events.ShardDisconnect, () => {
			if (this.clientValue !== client || this.statusValue.phase === 'destroyed') return
			this.#setStatus('connecting', { connectedAt: null })
		})
		client.on(Events.ShardResume, () => {
			if (this.clientValue !== client) return
			this.#setOnline(client)
		})
		client.on(Events.ShardError, (error) => this.options.onError(error))
		try {
			await withTimeout(client.login(this.config.token), this.options.readyTimeoutMs)
			if (this.clientValue !== client) throw new Error('Discord client was replaced while connecting')
			return this.#setOnline(client)
		} catch (error) {
			controller.abort(error)
			client.destroy()
			if (this.clientValue === client) {
				this.clientValue = undefined
				this.#setStatus('error', {
					lastError: error instanceof Error ? error.message : String(error),
					connectedAt: null,
					gateway: { applicationId: null, guilds: 0 },
				})
			}
			throw error
		}
	}

	async #stopConnection(): Promise<DiscordBotStatus> {
		if (this.statusValue.phase === 'destroyed') return this.statusValue
		this.#stopClient()
		this.#setStatus('offline', {
			lastError: null,
			connectedAt: null,
			gateway: { applicationId: null, guilds: 0 },
		})
		await this.operation?.catch((): undefined => undefined)
		return this.statusValue
	}

	#destroy(): void {
		if (this.statusValue.phase === 'destroyed') return
		this.#stopClient()
		this.#setStatus('destroyed', {
			lastError: null,
			connectedAt: null,
			gateway: { applicationId: null, guilds: 0 },
		})
	}

	#stopClient(): void {
		this.eventController?.abort('Discord bot stopped')
		this.eventController = undefined
		this.clientValue?.destroy()
		this.clientValue = undefined
	}

	async #resolveUserVoiceTarget(
		guildId: string,
		userId: string,
	): Promise<DiscordVoiceTarget> {
		const client = this.#requireReady()
		const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId))
		const member = await guild.members.fetch(userId)
		const channel = member.voice.channel
		if (!channel) throw new Error('请先加入一个 Discord 语音频道。')
		return this.#resolveVoiceTarget(guildId, channel.id)
	}

	async #resolveVoiceTarget(
		guildId: string,
		channelId: string,
	): Promise<DiscordVoiceTarget> {
		const client = this.#requireReady()
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

	async #listVoiceHumans(
		guildId: string,
		channelId: string,
	): Promise<readonly DiscordVoiceHuman[]> {
		const client = this.#requireReady()
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

	async #sendUserMessage(userId: string, message: string | DiscordMessage): Promise<void> {
		const user = await this.#requireReady().users.fetch(userId)
		await user.send(discordMessageOptions(message))
	}

	async #sendChannelMessage(
		channelId: string,
		message: DiscordMessage,
	): Promise<Readonly<{ id: string }>> {
		const channel = await this.#requireReady().channels.fetch(channelId)
		if (!channel?.isSendable()) throw new Error(`Discord channel is not sendable: ${channelId}`)
		const sent = await channel.send(discordMessageOptions(message))
		return { id: sent.id }
	}

	async #editChannelMessage(
		channelId: string,
		messageId: string,
		message: DiscordMessage,
	): Promise<void> {
		const channel = await this.#requireReady().channels.fetch(channelId)
		if (!channel?.isSendable()) throw new Error(`Discord channel is not sendable: ${channelId}`)
		await channel.messages.edit(messageId, discordMessageOptions(message))
	}

	#setActivity(activity: DiscordActivity | undefined): void {
		const client = this.#requireReady()
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

	async refreshCommands(
		catalog: DiscordCommandCatalogSnapshot,
		previouslyManaged: ReadonlyMap<string, ReadonlySet<string>>,
	): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
		if (this.statusValue.phase !== 'online' || !this.clientValue?.isReady())
			return previouslyManaged
		return this.syncCommands(this.clientValue, catalog.definitions, previouslyManaged)
	}

	private async syncCommands(
		client: Client<true>,
		definitions: DiscordCommandCatalogSnapshot['definitions'],
		previouslyManaged: ReadonlyMap<string, ReadonlySet<string>>,
	): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
		const targets =
			this.options.commandGuildIds.length === 0
				? ['global']
				: this.options.commandGuildIds.map((guildId) => `guild:${guildId}`)
		const allTargets = new Set([...previouslyManaged.keys(), ...targets])
		const current = new Map<string, ReadonlySet<string>>()
		for (const target of allTargets) {
			const manager = await this.commandManager(client, target)
			const roots = await reconcileDiscordCommands(
				manager,
				targets.includes(target) ? definitions : [],
				previouslyManaged.get(target) ?? new Set(),
			)
			if (targets.includes(target)) current.set(target, roots)
		}
		return current
	}

	private async commandManager(
		client: Client<true>,
		target: string,
	): Promise<DiscordCommandManager> {
		if (target === 'global') {
			if (!client.application) throw new Error('Discord application is unavailable after login')
			return discordCommandManager(client.application.commands)
		}
		const guildId = target.slice('guild:'.length)
		const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId))
		return discordCommandManager(guild.commands)
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
				const context: DiscordButtonContext = {
					...base,
					kind: 'button',
					customId: interaction.customId,
					...(interaction.guildId ? { guildId: interaction.guildId } : {}),
				}
				await this.options.dispatchInteraction(context)
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

	#requireReady(): Client<true> {
		if (this.statusValue.phase !== 'online' || !this.clientValue?.isReady()) {
			throw new Error(`Discord bot is not ready: ${this.id}`)
		}
		return this.clientValue
	}

	#setOnline(client: Client): DiscordBotStatus {
		const now = Date.now()
		this.selfInfoValue = client.user ?? undefined
		return this.#setStatus('online', {
			botId: client.user?.id ?? null,
			username: client.user?.username ?? null,
			lastError: null,
			connectedAt: this.statusValue.connectedAt ?? now,
			gateway: {
				applicationId: client.application?.id ?? null,
				guilds: client.guilds.cache.size,
				lastHealthyAt: now,
			},
		})
	}

	#setStatus(
		phase: DiscordBotStatus['phase'],
		patch: Parameters<typeof updateDiscordBotStatus>[1] = {},
	): DiscordBotStatus {
		this.statusValue = updateDiscordBotStatus(this.statusValue, { ...patch, phase })
		this.options.onChanged()
		return this.statusValue
	}

	#assertAlive(): void {
		if (this.statusValue.phase === 'destroyed')
			throw new Error(`Discord bot is destroyed: ${this.id}`)
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

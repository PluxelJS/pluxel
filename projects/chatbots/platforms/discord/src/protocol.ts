import type { Client, ClientUser, InternalDiscordGatewayAdapterCreator } from 'discord.js'
import type { DiscordBotStatus } from './bot/status.ts'

export type DiscordVoiceTarget = Readonly<{
	guildId: string
	channelId: string
	label: string
	opusBitrateLimitBps: number
	adapterCreator: InternalDiscordGatewayAdapterCreator
}>

export type DiscordVoiceHuman = Readonly<{
	id: string
	displayName: string
	avatarUrl?: string
}>

export type DiscordActivity = Readonly<{
	name: string
	type: 'playing' | 'listening'
}>

export type DiscordMessageButton =
	| Readonly<{
			kind: 'action'
			customId: string
			label: string
			style: 'primary' | 'success' | 'danger' | 'secondary'
	  }>
	| Readonly<{ kind: 'link'; url: string; label: string }>

export type DiscordMessage = Readonly<{
	content: string
	buttons?: readonly DiscordMessageButton[]
}>

/** Framework-added Discord helpers and lifecycle controls. */
export interface DiscordBotExtensions {
	readonly info: Readonly<{ id: string; apiBase: string }>
	readonly status: Readonly<DiscordBotStatus>
	resolveUserVoiceTarget(guildId: string, userId: string): Promise<DiscordVoiceTarget>
	resolveVoiceTarget(guildId: string, channelId: string): Promise<DiscordVoiceTarget>
	listVoiceHumans(guildId: string, channelId: string): Promise<readonly DiscordVoiceHuman[]>
	sendUserMessage(userId: string, message: string | DiscordMessage): Promise<void>
	sendChannelMessage(
		channelId: string,
		message: DiscordMessage,
	): Promise<Readonly<{ id: string }>>
	editChannelMessage(channelId: string, messageId: string, message: DiscordMessage): Promise<void>
	setActivity(activity: DiscordActivity | undefined): void
	start(): Promise<DiscordBotStatus>
	stop(): Promise<DiscordBotStatus>
	destroy(): void
}

export interface DiscordBot {
	readonly id: string
	/** Native Discord identity after a successful login. */
	readonly selfInfo: ClientUser | undefined
	/** Native discord.js client. Throws while the Bot is not online. */
	readonly client: Client<true>
	readonly $: DiscordBotExtensions
}

type DiscordInteractionBase = Readonly<{
	id: string
	bot: DiscordBot
	guildId?: string
	channelId: string
	user: Readonly<{
		id: string
		displayName: string
		avatarUrl?: string
	}>
	signal: AbortSignal
	respond(message: string | DiscordMessage): Promise<void>
	responded(): boolean
}>

export type DiscordButtonContext = DiscordInteractionBase &
	Readonly<{ kind: 'button'; customId: string }>

export type DiscordBotConfigInput = Readonly<{
	id: string
	token?: string
	apiBase?: string
}>

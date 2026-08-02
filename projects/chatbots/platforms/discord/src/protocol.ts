import type { InternalDiscordGatewayAdapterCreator } from 'discord.js'

export type DiscordBotState = 'connecting' | 'ready' | 'failed' | 'stopped'

export type DiscordBotSnapshot = Readonly<{
	id: string
	state: DiscordBotState
	epoch: number
	applicationId?: string
	userId?: string
	username?: string
	guilds: number
	connectedAt?: number
	lastHealthyAt?: number
	failureMessage?: string
}>

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

export interface DiscordBot {
	readonly id: string
	snapshot(): DiscordBotSnapshot
	resolveUserVoiceTarget(guildId: string, userId: string): Promise<DiscordVoiceTarget>
	resolveVoiceTarget(guildId: string, channelId: string): Promise<DiscordVoiceTarget>
	listVoiceHumans(guildId: string, channelId: string): Promise<readonly DiscordVoiceHuman[]>
	sendUserMessage(userId: string, message: string | DiscordMessage): Promise<void>
	sendChannelMessage(channelId: string, message: DiscordMessage): Promise<Readonly<{ id: string }>>
	editChannelMessage(channelId: string, messageId: string, message: DiscordMessage): Promise<void>
	setActivity(activity: DiscordActivity | undefined): void
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

export interface DiscordBotDirectory {
	list(): readonly DiscordBotSnapshot[]
	get(id: string): DiscordBot | undefined
	observe(observer: () => void): () => void
}

export type DiscordBotConfigInput = Readonly<{
	id: string
	token?: string
}>

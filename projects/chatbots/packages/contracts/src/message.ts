import type { ChatBlock, ChatId } from './content.ts'

export type ChatPlatformName = string
export type ChatAccountId = string

export type ChatTransportRef = {
	readonly platform: ChatPlatformName
	readonly accountId: ChatAccountId
}

export type ChatAddress = ChatTransportRef & {
	readonly conversationId: ChatId
}

export type ChatActor = {
	id: ChatId
	displayName?: string
	username?: string
	isBot?: boolean
}

export type ChatConversation = {
	id: ChatId
	kind: 'direct' | 'group' | 'channel'
	title?: string
}

/** Stable, JSON-safe boundary shared by adapters and business plugins. */
export type ChatMessage = {
	id: ChatId
	platform: ChatPlatformName
	accountId: ChatAccountId
	conversation: ChatConversation
	actor: ChatActor
	content: readonly ChatBlock[]
	/** Searchable plain-text projection of content. */
	text: string
	createdAt: number
	replyToId?: ChatId
	metadata?: Readonly<Record<string, unknown>>
}

export function transportKey(ref: ChatTransportRef): string {
	return `${ref.platform.length}:${ref.platform}${ref.accountId.length}:${ref.accountId}`
}

export function conversationKey(
	message: Pick<ChatMessage, 'platform' | 'accountId' | 'conversation'>,
): string {
	const transport = transportKey(message)
	return `${transport.length}:${transport}${message.conversation.id.length}:${message.conversation.id}`
}

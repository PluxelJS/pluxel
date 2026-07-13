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

export function addressKey(address: ChatAddress): string {
	const transport = transportKey(address)
	return `${transport.length}:${transport}${address.conversationId.length}:${address.conversationId}`
}

export function conversationKey(
	message: Pick<ChatMessage, 'platform' | 'accountId' | 'conversation'>,
): string {
	return addressKey({
		platform: message.platform,
		accountId: message.accountId,
		conversationId: message.conversation.id,
	})
}

/** Stable process-independent key suitable for idempotency records. */
export function messageKey(
	message: Pick<ChatMessage, 'id' | 'platform' | 'accountId' | 'conversation'>,
): string {
	const conversation = conversationKey(message)
	return `${conversation.length}:${conversation}${message.id.length}:${message.id}`
}

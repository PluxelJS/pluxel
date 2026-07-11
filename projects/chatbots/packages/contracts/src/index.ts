export type ChatTransportName = string
export type ChatId = string

export type TextBlock = { type: 'text'; text: string }
export type ImageBlock = { type: 'image'; url: string; alt?: string }
export type FileBlock = { type: 'file'; url: string; name?: string; mediaType?: string }
export type ChatBlock = TextBlock | ImageBlock | FileBlock
export type ChatContent = string | readonly ChatBlock[]

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
	transport: ChatTransportName
	conversation: ChatConversation
	actor: ChatActor
	content: readonly ChatBlock[]
	text: string
	createdAt: number
	replyToId?: ChatId
	metadata?: Readonly<Record<string, unknown>>
}

export type ChatSendRequest = {
	conversationId: ChatId
	content: ChatContent
	replyToId?: ChatId
}

export type ChatSendResult = { messageId: ChatId }

export interface ChatTransport {
	readonly name: ChatTransportName
	send(request: ChatSendRequest, signal?: AbortSignal): Promise<ChatSendResult>
}

export function normalizeContent(content: ChatContent): ChatBlock[] {
	return typeof content === 'string'
		? [{ type: 'text', text: content }]
		: content.map((block) => ({ ...block }))
}

export function contentText(content: readonly ChatBlock[]): string {
	return content
		.map((block) =>
			block.type === 'text'
				? block.text
				: block.type === 'image'
					? (block.alt ?? block.url)
					: (block.name ?? block.url),
		)
		.join('\n')
		.trim()
}

export function conversationKey(message: Pick<ChatMessage, 'transport' | 'conversation'>): string {
	return `${message.transport}:${message.conversation.id}`
}

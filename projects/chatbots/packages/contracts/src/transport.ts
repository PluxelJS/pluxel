import type { ChatBlockType, ChatContent, ChatId } from './content.ts'
import type { ChatTransportRef } from './message.ts'

export type ChatDeliveryMode = 'best-effort' | 'strict'

export type ChatSendRequest = {
	conversationId: ChatId
	content: ChatContent
	replyToId?: ChatId
	mode?: ChatDeliveryMode
}

export type ChatSendResult = {
	/** Last emitted platform message. Kept convenient for reply/edit workflows. */
	messageId: ChatId
	/** Present when one logical delivery was split into multiple platform messages. */
	messageIds?: readonly ChatId[]
	/** Failed logical batch items. Only returned by best-effort delivery. */
	failures?: readonly { index: number; message: string }[]
}

export type ChatTransportCapabilities = {
	/** Atomic block types accepted by send(). Text-like blocks may still be rendered to text. */
	blocks: readonly ChatBlockType[]
	/** Whether a single send() accepts more than one block. */
	mixedContent?: boolean
	/** Supported blocks that must still be emitted as an isolated platform operation. */
	atomicBlocks?: readonly ChatBlockType[]
	maxTextLength?: number
}

export interface ChatTransport extends ChatTransportRef {
	readonly capabilities?: ChatTransportCapabilities
	send(request: ChatSendRequest, signal?: AbortSignal): Promise<ChatSendResult>
}

import type { ChatBlock, ChatContent } from './content.ts'

export type ChatContentLike = ChatContent | ChatBlock | string | number | null | undefined
export type ChatBatchStrategy = 'fail-fast' | 'best-effort'
export type ChatBatch = {
	kind: 'chat-batch'
	messages: readonly (readonly ChatBlock[])[]
	strategy: ChatBatchStrategy
}
export type ChatPayload = ChatContent | ChatBatch

export function isChatBatch(value: unknown): value is ChatBatch {
	return (
		Boolean(value) &&
		typeof value === 'object' &&
		(value as { kind?: unknown }).kind === 'chat-batch' &&
		Array.isArray((value as { messages?: unknown }).messages)
	)
}

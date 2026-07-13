import type {
	ChatDeliveryMode,
	ChatMessage,
	ChatPayload,
	ChatSendResult,
	ChatTransportRef,
} from '@repo/chatbots-contracts'

export type ChatHandlerResult = void | 'stop'
export type ChatHandlerContext = {
	message: ChatMessage
	signal: AbortSignal
	reply(content: ChatPayload, options?: { mode?: ChatDeliveryMode }): Promise<ChatSendResult>
	send(
		conversationId: string,
		content: ChatPayload,
		options?: { mode?: ChatDeliveryMode },
	): Promise<ChatSendResult>
}
export type ChatHandler = (
	context: ChatHandlerContext,
) => ChatHandlerResult | Promise<ChatHandlerResult>
export type ChatHandlerSpec = {
	id: string
	handle: ChatHandler
	/** Lower values run first. @default 100 */
	priority?: number
}
export type ChatObserver = (message: ChatMessage, signal: AbortSignal) => void | Promise<void>
export type ChatHubLogger = {
	debug(message: string, data?: Record<string, unknown>): void
	warn(message: string, data?: Record<string, unknown>): void
}
export type ChatRouterSnapshot = {
	transports: ChatTransportRef[]
	handlers: Array<{ id: string; priority: number }>
	observers: string[]
	activeConversations: number
	pendingReceives: number
	outboundConversations: number
	pendingSends: number
	runningSends: number
	received: number
	deduplicated: number
	rejectedReceives: number
	handled: number
	failedHandlers: number
	sent: number
	failedSends: number
	rejectedSends: number
	drainTimeouts: number
}

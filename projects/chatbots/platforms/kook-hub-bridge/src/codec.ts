import type { KookBot, KookEvent } from '@repo/chatbots-kook'
import {
	blockText,
	contentText,
	normalizeContent,
	type ChatBlock,
	type ChatMessage,
	type ChatSendRequest,
	type ChatTransportCapabilities,
} from '@repo/chatbots-contracts'

const KOOK_TEXT = 1
const KOOK_IMAGE = 2
const KOOK_VIDEO = 3
const KOOK_FILE = 4
const KOOK_KMARKDOWN = 9

export const KOOK_TRANSPORT_CAPABILITIES = {
	blocks: ['text', 'image', 'audio', 'video', 'file'],
	mixedContent: false,
} as const satisfies ChatTransportCapabilities

export async function sendKook(bot: KookBot, request: ChatSendRequest, signal?: AbortSignal) {
	const target = parseKookConversationId(request.conversationId)
	let lastMessageId = ''
	for (const block of normalizeContent(request.content)) {
		if (signal?.aborted) throw signal.reason
		const payload = {
			target_id: target.targetId,
			...encodeKookBlock(block),
			...(request.replyToId ? { quote: request.replyToId } : {}),
		}
		const result = target.direct
			? await bot.$.raw.call('createDirectMessage', payload, { signal })
			: await bot.$.raw.call('sendMessage', payload, { signal })
		if (result.ok === false) throw new Error(`KOOK API error ${result.code}: ${result.message}`)
		lastMessageId = result.data.msg_id
	}
	if (!lastMessageId) throw new Error('KOOK send requires non-empty content')
	return { messageId: lastMessageId }
}

export function encodeKookBlock(block: ChatBlock): { type: number; content: string } {
	if (block.type === 'text') return { type: KOOK_TEXT, content: block.text }
	if (block.type === 'image') return { type: KOOK_IMAGE, content: block.url }
	if (block.type === 'video') return { type: KOOK_VIDEO, content: block.url }
	if (block.type === 'audio' || block.type === 'file')
		return { type: KOOK_FILE, content: block.url }
	return { type: KOOK_TEXT, content: blockText(block) }
}

export function normalizeKookEvent(
	event: KookEvent,
	botId?: string,
	accountId = 'default',
): ChatMessage | undefined {
	if (!event.msg_id || !event.author_id || event.author_id === botId) return undefined
	const author = event.extra?.author
	if (author?.bot) return undefined
	const blocks: ChatBlock[] = []
	const text = event.extra?.kmarkdown?.raw_content ?? event.content ?? ''
	if (event.type === KOOK_TEXT || event.type === KOOK_KMARKDOWN) {
		if (text) blocks.push({ type: 'text', text })
	} else if (event.type === KOOK_IMAGE && event.content) {
		blocks.push({ type: 'image', url: event.content })
	} else if (event.type === KOOK_FILE && event.content) {
		blocks.push({ type: 'file', url: event.content })
	} else if (event.type === KOOK_VIDEO && event.content) {
		blocks.push({ type: 'video', url: event.content })
	}
	const attachments = event.extra?.attachments
	for (const attachment of attachments
		? Array.isArray(attachments)
			? attachments
			: [attachments]
		: []) {
		if (!attachment.url) continue
		if (attachment.type === 'image')
			blocks.push({ type: 'image', url: attachment.url, alt: attachment.name })
		else
			blocks.push({
				type: 'file',
				url: attachment.url,
				name: attachment.name,
				mediaType: attachment.file_type,
			})
	}
	if (blocks.length === 0) return undefined
	const direct = event.channel_type === 'PERSON'
	return {
		id: event.msg_id,
		platform: 'kook',
		accountId,
		conversation: {
			id: direct ? `direct:${event.author_id}` : `channel:${event.target_id}`,
			kind: direct ? 'direct' : 'channel',
			title: event.extra?.channel_name,
		},
		actor: {
			id: event.author_id,
			displayName: author?.nickname ?? author?.username,
			username: author?.username,
			isBot: author?.bot,
		},
		content: blocks,
		text: contentText(blocks),
		createdAt:
			event.msg_timestamp > 0 && event.msg_timestamp < 10_000_000_000
				? event.msg_timestamp * 1_000
				: event.msg_timestamp,
		metadata: { guildId: event.extra?.guild_id, messageType: event.type },
	}
}

export function parseKookConversationId(value: string): { direct: boolean; targetId: string } {
	const separator = value.indexOf(':')
	if (separator <= 0 || separator === value.length - 1)
		throw new Error(`Invalid KOOK conversation id: ${value}`)
	const kind = value.slice(0, separator)
	if (kind !== 'direct' && kind !== 'channel')
		throw new Error(`Unsupported KOOK conversation kind: ${kind}`)
	return { direct: kind === 'direct', targetId: value.slice(separator + 1) }
}

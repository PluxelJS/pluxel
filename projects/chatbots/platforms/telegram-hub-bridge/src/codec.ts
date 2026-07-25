import type { TelegramBot, TelegramUpdate } from '@repo/chatbots-telegram'
import {
	contentText,
	normalizeContent,
	type ChatBlock,
	type ChatMessage,
	type ChatSendRequest,
	type ChatTransportCapabilities,
} from '@repo/chatbots-contracts'

export const TELEGRAM_TRANSPORT_CAPABILITIES = {
	blocks: ['text', 'image', 'audio', 'video', 'file'],
	mixedContent: false,
	maxTextLength: 4096,
} as const satisfies ChatTransportCapabilities

export async function sendTelegram(
	bot: TelegramBot,
	request: ChatSendRequest,
	signal?: AbortSignal,
) {
	const blocks = normalizeContent(request.content)
	if (blocks.length !== 1) throw new Error('Telegram transport expects one planned block per send')
	const payload = telegramOutboundPayload(blocks[0]!)
	const replyMessageId = request.replyToId === undefined ? undefined : Number(request.replyToId)
	if (replyMessageId !== undefined && !Number.isSafeInteger(replyMessageId))
		throw new Error(`Telegram reply message id must be an integer: ${request.replyToId}`)
	const sent = await bot.$.raw.call(
		payload.method,
		{
			chat_id: request.conversationId,
			...payload.body,
			...(replyMessageId === undefined ? {} : { reply_parameters: { message_id: replyMessageId } }),
		} as never,
		{ signal },
	)
	return { messageId: String(sent.message_id) }
}

export function normalizeTelegramUpdate(
	update: TelegramUpdate,
	accountId = 'default',
): ChatMessage | undefined {
	const source = update.message ?? update.channel_post
	if (!source) return undefined
	const blocks: ChatBlock[] = []
	const attachments: TelegramAttachment[] = []
	const text = source.text ?? source.caption ?? ''
	if (text) blocks.push({ type: 'text', text })
	const photo = source.photo?.at(-1)
	if (photo)
		attachments.push({
			type: 'image',
			fileId: photo.file_id,
			fileUniqueId: photo.file_unique_id,
		})
	if (source.audio)
		attachments.push({
			type: 'audio',
			fileId: source.audio.file_id,
			fileUniqueId: source.audio.file_unique_id,
			name: source.audio.file_name,
			mediaType: source.audio.mime_type,
		})
	if (source.video)
		attachments.push({
			type: 'video',
			fileId: source.video.file_id,
			fileUniqueId: source.video.file_unique_id,
			name: source.video.file_name,
			mediaType: source.video.mime_type,
		})
	if (source.document)
		attachments.push({
			type: 'file',
			fileId: source.document.file_id,
			fileUniqueId: source.document.file_unique_id,
			name: source.document.file_name,
			mediaType: source.document.mime_type,
		})
	for (const attachment of attachments) {
		blocks.push({
			type: 'text',
			text: `[Telegram ${attachment.type}${attachment.name ? `: ${attachment.name}` : ''}]`,
		})
	}
	if (blocks.length === 0) return undefined
	const actor = source.from
	return {
		id: String(source.message_id),
		platform: 'telegram',
		accountId,
		conversation: {
			id: String(source.chat.id),
			kind:
				source.chat.type === 'private'
					? 'direct'
					: source.chat.type === 'channel'
						? 'channel'
						: 'group',
			title: source.chat.title,
		},
		actor: {
			id: String(actor?.id ?? source.sender_chat?.id ?? source.chat.id),
			displayName:
				(actor
					? [actor.first_name, actor.last_name].filter(Boolean).join(' ') || actor.username
					: source.sender_chat?.title) ?? source.chat.title,
			username: actor?.username,
			isBot: actor?.is_bot,
		},
		content: blocks,
		text: contentText(blocks),
		createdAt: source.date * 1_000,
		metadata: {
			updateId: update.update_id,
			...(attachments.length > 0 ? { telegramAttachments: attachments } : {}),
		},
	}
}

export type TelegramSendMethod =
	| 'sendMessage'
	| 'sendPhoto'
	| 'sendAudio'
	| 'sendVideo'
	| 'sendDocument'

export function telegramOutboundPayload(block: ChatBlock): {
	method: TelegramSendMethod
	body: Record<string, unknown>
} {
	if (block.type === 'text') return { method: 'sendMessage', body: { text: block.text } }
	if (block.type === 'image')
		return {
			method: 'sendPhoto',
			body: {
				photo: block.url,
				...(block.alt ? { caption: block.alt } : {}),
			},
		}
	if (block.type === 'audio') return { method: 'sendAudio', body: { audio: block.url } }
	if (block.type === 'video') return { method: 'sendVideo', body: { video: block.url } }
	if (block.type === 'file') return { method: 'sendDocument', body: { document: block.url } }
	return { method: 'sendMessage', body: { text: contentText([block]) } }
}

type TelegramAttachment = Readonly<{
	type: 'image' | 'audio' | 'video' | 'file'
	fileId: string
	fileUniqueId: string
	name?: string
	mediaType?: string
}>

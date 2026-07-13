import {
	contentText,
	type ChatBlock,
	type ChatMessage,
	type ChatTransportCapabilities,
} from '@repo/chatbots-contracts'
import type { TelegramUpdate } from '@gramio/types'

export const TELEGRAM_TRANSPORT_CAPABILITIES = {
	blocks: ['text', 'image', 'audio', 'video', 'file'],
	mixedContent: false,
	maxTextLength: 4096,
} as const satisfies ChatTransportCapabilities

export function normalizeTelegramUpdate(
	update: TelegramUpdate,
	accountId = 'default',
): ChatMessage | undefined {
	const source = update.message ?? update.channel_post
	if (!source) return undefined
	const blocks: ChatBlock[] = []
	const text = source.text ?? source.caption ?? ''
	if (text) blocks.push({ type: 'text', text })
	const photo = source.photo?.at(-1)
	if (photo) blocks.push({ type: 'image', url: telegramResource(photo.file_id) })
	if (source.audio)
		blocks.push({
			type: 'audio',
			url: telegramResource(source.audio.file_id),
			name: source.audio.file_name,
			mediaType: source.audio.mime_type,
		})
	if (source.video)
		blocks.push({
			type: 'video',
			url: telegramResource(source.video.file_id),
			name: source.video.file_name,
			mediaType: source.video.mime_type,
		})
	if (source.document)
		blocks.push({
			type: 'file',
			url: telegramResource(source.document.file_id),
			name: source.document.file_name,
			mediaType: source.document.mime_type,
		})
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
		metadata: { updateId: update.update_id },
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
				photo: telegramApiResource(block.url),
				...(block.alt ? { caption: block.alt } : {}),
			},
		}
	if (block.type === 'audio')
		return { method: 'sendAudio', body: { audio: telegramApiResource(block.url) } }
	if (block.type === 'video')
		return { method: 'sendVideo', body: { video: telegramApiResource(block.url) } }
	if (block.type === 'file')
		return { method: 'sendDocument', body: { document: telegramApiResource(block.url) } }
	return { method: 'sendMessage', body: { text: contentText([block]) } }
}

function telegramResource(fileId: string): string {
	return `telegram:file:${fileId}`
}
function telegramApiResource(value: string): string {
	return value.startsWith('telegram:file:') ? value.slice('telegram:file:'.length) : value
}

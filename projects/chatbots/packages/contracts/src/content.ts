export type ChatId = string

export type TextBlock = { type: 'text'; text: string }
export type MentionBlock = { type: 'mention'; actorId: ChatId; label?: string }
export type LinkBlock = { type: 'link'; url: string; label?: string }
export type CodeBlock = { type: 'code'; code: string; language?: string; inline?: boolean }
/** A transport-independent media URL. Account-local platform file IDs do not belong here. */
export type ImageBlock = { type: 'image'; url: string; alt?: string }
/** A transport-independent media URL. Account-local platform file IDs do not belong here. */
export type AudioBlock = { type: 'audio'; url: string; name?: string; mediaType?: string }
/** A transport-independent media URL. Account-local platform file IDs do not belong here. */
export type VideoBlock = { type: 'video'; url: string; name?: string; mediaType?: string }
/** A transport-independent media URL. Account-local platform file IDs do not belong here. */
export type FileBlock = { type: 'file'; url: string; name?: string; mediaType?: string }
export type ChatBlock =
	| TextBlock
	| MentionBlock
	| LinkBlock
	| CodeBlock
	| ImageBlock
	| AudioBlock
	| VideoBlock
	| FileBlock
export type ChatBlockType = ChatBlock['type']
export type ChatContent = string | readonly ChatBlock[]

export function normalizeContent(content: ChatContent): ChatBlock[] {
	return typeof content === 'string'
		? content
			? [{ type: 'text', text: content }]
			: []
		: content.map((block) => ({ ...block }))
}

export function blockText(block: ChatBlock): string {
	switch (block.type) {
		case 'text':
			return block.text
		case 'mention':
			return `@${block.label ?? block.actorId}`
		case 'link':
			return block.label ? `${block.label} (${block.url})` : block.url
		case 'code':
			return block.inline ? block.code : `\`\`\`${block.language ?? ''}\n${block.code}\n\`\`\``
		case 'image':
			return block.alt ?? block.url
		case 'audio':
		case 'video':
		case 'file':
			return block.name ?? block.url
	}
}

export function contentText(content: readonly ChatBlock[]): string {
	return content.map(blockText).filter(Boolean).join('\n').trim()
}

export function isTextBlock(block: ChatBlock): boolean {
	return (
		block.type === 'text' ||
		block.type === 'mention' ||
		block.type === 'link' ||
		block.type === 'code'
	)
}

import { normalizeContent, type ChatBlock } from './content.ts'
import type { ChatBatch, ChatContentLike } from './payload.ts'

function append(out: ChatBlock[], block: ChatBlock): void {
	if (block.type === 'text') {
		if (!block.text) return
		const previous = out.at(-1)
		if (previous?.type === 'text') {
			previous.text += block.text
			return
		}
	}
	out.push({ ...block })
}

export function contentOf(...items: ChatContentLike[]): ChatBlock[] {
	const out: ChatBlock[] = []
	for (const item of items) {
		if (item === null || item === undefined) continue
		if (typeof item === 'string' || typeof item === 'number') {
			append(out, { type: 'text', text: String(item) })
			continue
		}
		if (Array.isArray(item)) {
			for (const block of item) append(out, block)
			continue
		}
		append(out, item as ChatBlock)
	}
	return out
}

function safeJson(value: unknown): string {
	return JSON.stringify(jsonValue(value, new WeakSet()), null, 2) ?? 'null'
}

function jsonValue(value: unknown, ancestors: WeakSet<object>): unknown {
	if (typeof value === 'bigint') return value.toString()
	if (!value || typeof value !== 'object') return value
	if (value instanceof Date) return value.toISOString()
	if (value instanceof Error)
		return { name: value.name, message: value.message, stack: value.stack }
	if (ancestors.has(value)) return '[Circular]'
	ancestors.add(value)
	const normalized = Array.isArray(value)
		? value.map((item) => jsonValue(item, ancestors))
		: Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, jsonValue(item, ancestors)]),
			)
	ancestors.delete(value)
	return normalized
}

function batch(strategy: ChatBatch['strategy'], messages: ChatContentLike[]): ChatBatch {
	return {
		kind: 'chat-batch',
		strategy,
		messages: messages.map((message) => contentOf(message)).filter((message) => message.length > 0),
	}
}

/** JSON-safe content builders; no platform session or binary state is retained. */
export const chat = {
	empty: (): ChatBlock[] => [],
	text: (value: string | number): ChatBlock[] => normalizeContent(String(value)),
	lines: (...values: Array<string | number | null | undefined>): ChatBlock[] =>
		normalizeContent(values.filter((value) => value !== null && value !== undefined).join('\n')),
	json: (value: unknown): ChatBlock[] => [
		{ type: 'code', code: safeJson(value), language: 'json', inline: false },
	],
	of: contentOf,
	mention: (actorId: string, label?: string): ChatBlock => ({ type: 'mention', actorId, label }),
	link: (url: string, label?: string): ChatBlock => ({ type: 'link', url, label }),
	code: (code: string, language?: string): ChatBlock => ({
		type: 'code',
		code,
		language,
		inline: false,
	}),
	image: (url: string, alt?: string): ChatBlock => ({ type: 'image', url, alt }),
	audio: (url: string, name?: string, mediaType?: string): ChatBlock => ({
		type: 'audio',
		url,
		name,
		mediaType,
	}),
	video: (url: string, name?: string, mediaType?: string): ChatBlock => ({
		type: 'video',
		url,
		name,
		mediaType,
	}),
	file: (url: string, name?: string, mediaType?: string): ChatBlock => ({
		type: 'file',
		url,
		name,
		mediaType,
	}),
	batch: (...messages: ChatContentLike[]): ChatBatch => batch('fail-fast', messages),
	batchBestEffort: (...messages: ChatContentLike[]): ChatBatch => batch('best-effort', messages),
} as const

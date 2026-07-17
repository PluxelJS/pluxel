import {
	blockText,
	isTextBlock,
	normalizeContent,
	type ChatBlock,
	type ChatTransportCapabilities,
	type ChatSendRequest,
	type ChatTransport,
} from '@repo/chatbots-contracts'

/** Plans rich logical content into atomic sends supported by one transport. */
export function planChatDelivery(
	transport: ChatTransport,
	request: ChatSendRequest,
): ChatSendRequest[] {
	const blocks = normalizeContent(request.content)
	if (blocks.length === 0) throw new Error('Chat delivery requires non-empty content')
	const capabilities = transport.capabilities
	if (!capabilities) return [{ ...request, content: blocks }]

	const normalized = normalizeBlocks(
		`${transport.platform}/${transport.accountId}`,
		blocks,
		capabilities,
		request.mode,
	)
	if (capabilities.mixedContent) {
		return withReplySemantics(
			request,
			layoutMixed(normalized, capabilities.maxTextLength, capabilities.atomicBlocks),
		)
	}

	const planned: ChatBlock[][] = []
	let text = ''
	const flushText = () => {
		if (!text) return
		for (const chunk of splitText(text, capabilities.maxTextLength))
			planned.push([{ type: 'text', text: chunk }])
		text = ''
	}

	for (const block of normalized) {
		if (isTextBlock(block)) {
			const next = blockText(block)
			text += text && next ? `\n${next}` : next
			continue
		}
		flushText()
		planned.push([block])
	}
	flushText()
	return withReplySemantics(request, planned)
}

function withReplySemantics(
	request: ChatSendRequest,
	planned: readonly ChatBlock[][],
): ChatSendRequest[] {
	return planned.map((content, index) => ({
		...request,
		content,
		replyToId: index === 0 ? request.replyToId : undefined,
	}))
}

function normalizeBlocks(
	transportName: string,
	blocks: readonly ChatBlock[],
	capabilities: ChatTransportCapabilities,
	mode: ChatSendRequest['mode'],
): ChatBlock[] {
	const supported = new Set(capabilities.blocks)
	const normalized: ChatBlock[] = []
	for (const block of blocks) {
		if (supported.has(block.type)) appendBlock(normalized, block)
		else if (isTextBlock(block)) appendBlock(normalized, { type: 'text', text: blockText(block) })
		else if (mode === 'strict')
			throw new Error(`Transport ${transportName} does not support ${block.type}`)
		else
			appendBlock(normalized, {
				type: 'text',
				text: `${normalized.at(-1)?.type === 'text' ? '\n' : ''}[${block.type}] ${blockText(block)}`,
			})
	}
	return normalized
}

function appendBlock(target: ChatBlock[], block: ChatBlock): void {
	if (block.type === 'text') {
		if (!block.text) return
		const previous = target.at(-1)
		if (previous?.type === 'text') {
			previous.text += block.text
			return
		}
	}
	target.push({ ...block })
}

function layoutMixed(
	blocks: readonly ChatBlock[],
	limit?: number,
	atomicBlocks: readonly ChatBlock['type'][] = [],
): ChatBlock[][] {
	if (!limit && atomicBlocks.length === 0) return [[...blocks]]
	const atomic = new Set(atomicBlocks)
	const textLimit = limit ?? Number.POSITIVE_INFINITY
	const planned: ChatBlock[][] = []
	let current: ChatBlock[] = []
	let textLength = 0
	const flush = () => {
		if (current.length > 0) planned.push(current)
		current = []
		textLength = 0
	}
	for (const block of blocks) {
		if (atomic.has(block.type)) {
			flush()
			planned.push([block])
			continue
		}
		if (!isTextBlock(block)) {
			current.push(block)
			continue
		}
		const rendered = blockText(block)
		if (block.type !== 'text' && rendered.length <= textLimit) {
			if (textLength + rendered.length > textLimit) flush()
			current.push(block)
			textLength += rendered.length
			continue
		}
		for (const chunk of splitText(rendered, limit)) {
			if (textLength + chunk.length > textLimit) flush()
			appendBlock(current, { type: 'text', text: chunk })
			textLength += chunk.length
		}
	}
	flush()
	return planned
}

/** Splits by the transport's UTF-16 limit without cutting surrogate pairs. */
function splitText(value: string, limit?: number): string[] {
	if (!limit || value.length <= limit) return value ? [value] : []
	const chunks: string[] = []
	let start = 0
	while (start < value.length) {
		let end = Math.min(value.length, start + limit)
		if (end < value.length && isHighSurrogate(value.charCodeAt(end - 1))) end--
		const minimumReadableBreak = start + Math.floor(limit * 0.6)
		if (end < value.length) {
			const newline = value.lastIndexOf('\n', end - 1)
			const space = value.lastIndexOf(' ', end - 1)
			const readableBreak = Math.max(newline, space)
			if (readableBreak >= minimumReadableBreak) end = readableBreak + 1
		}
		if (end <= start) end = Math.min(value.length, start + limit)
		chunks.push(value.slice(start, end))
		start = end
	}
	return chunks
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff
}

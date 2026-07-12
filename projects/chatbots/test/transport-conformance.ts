import type { ChatBlock, ChatBlockType, ChatTransportCapabilities } from '@repo/chatbots-hub'

const samples: Record<ChatBlockType, ChatBlock> = {
	text: { type: 'text', text: 'hello' },
	mention: { type: 'mention', actorId: '42', label: 'Alice' },
	link: { type: 'link', url: 'https://example.test', label: 'example' },
	code: { type: 'code', code: 'const ok = true', language: 'ts' },
	image: { type: 'image', url: 'https://example.test/image.png', alt: 'image' },
	audio: { type: 'audio', url: 'https://example.test/audio.mp3', name: 'audio' },
	video: { type: 'video', url: 'https://example.test/video.mp4', name: 'video' },
	file: { type: 'file', url: 'https://example.test/file.zip', name: 'file' },
}

/** Fails when an adapter advertises a block that its pure encoder cannot consume. */
export function assertTransportConformance(
	capabilities: ChatTransportCapabilities,
	encode: (block: ChatBlock) => unknown,
): void {
	for (const type of capabilities.blocks) {
		const output = encode(samples[type])
		if (output === undefined || output === null)
			throw new Error(`Encoder returned no output for declared ${type} capability`)
	}
}

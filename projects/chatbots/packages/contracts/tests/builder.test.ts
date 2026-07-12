import { describe, expect, it } from 'vitest'
import { chat, contentText } from '../src/index.ts'

describe('chat content builder', () => {
	it('coalesces adjacent text while preserving semantic blocks', () => {
		const content = chat.of('hello', ' ', 42, chat.link('https://example.test', 'example'))
		expect(content).toEqual([
			{ type: 'text', text: 'hello 42' },
			{ type: 'link', url: 'https://example.test', label: 'example' },
		])
		expect(contentText(content)).toBe('hello 42\nexample (https://example.test)')
	})

	it('serializes errors, bigint and circular data safely', () => {
		const value: Record<string, unknown> = { count: 2n, error: new Error('boom') }
		value.self = value
		const block = chat.json(value)[0]
		if (block?.type !== 'code') throw new Error('Expected a code block')
		expect(block.code).toContain('"count": "2"')
		expect(block.code).toContain('[Circular]')
	})

	it('does not mistake shared references for circular data', () => {
		const shared = { value: 1 }
		const block = chat.json({ first: shared, second: shared })[0]
		expect(block?.type === 'code' ? block.code : '').not.toContain('[Circular]')
	})

	it('provides constructors for every media block', () => {
		expect(chat.audio('audio.mp3', 'audio')).toMatchObject({ type: 'audio', name: 'audio' })
		expect(chat.video('video.mp4', 'video')).toMatchObject({ type: 'video', name: 'video' })
	})
})

import { describe, expect, it } from 'vitest'
import type { KookEvent } from '@repo/chatbots-kook'
import { assertTransportConformance } from '../../../test/transport-conformance.ts'
import {
	encodeKookBlock,
	KOOK_TRANSPORT_CAPABILITIES,
	normalizeKookEvent,
	parseKookConversationId,
} from '../src/codec.ts'

function event(patch: Partial<KookEvent> = {}): KookEvent {
	return {
		type: 9,
		target_id: 'channel-1',
		author_id: 'user-1',
		content: '(met)bot(met) ping',
		msg_id: 'message-1',
		msg_timestamp: 1_700_000_000_000,
		channel_type: 'GROUP',
		extra: {
			guild_id: 'guild-1',
			channel_name: 'general',
			author: { username: 'alice', nickname: 'Alice', bot: false },
			kmarkdown: { raw_content: '/ping' },
		},
		...patch,
	}
}

describe('KOOK ChatHub bridge', () => {
	it('normalizes group KMarkdown into a stable chat message', () => {
		expect(normalizeKookEvent(event(), 'bot-1', 'community')).toMatchObject({
			id: 'message-1',
			platform: 'kook',
			accountId: 'community',
			conversation: { id: 'channel:channel-1', kind: 'channel', title: 'general' },
			actor: { id: 'user-1', displayName: 'Alice' },
			text: '/ping',
			content: [{ type: 'text', text: '/ping' }],
		})
	})

	it('uses the author as the direct-message target and filters bots', () => {
		const direct = normalizeKookEvent(event({ channel_type: 'PERSON' }), 'bot-1')
		expect(direct?.conversation).toMatchObject({ id: 'direct:user-1', kind: 'direct' })
		expect(normalizeKookEvent(event({ author_id: 'bot-1' }), 'bot-1')).toBeUndefined()
		expect(normalizeKookEvent(event({ extra: { author: { bot: true } } }), 'bot-1')).toBeUndefined()
	})

	it('parses outbound conversation ids', () => {
		expect(parseKookConversationId('channel:123')).toEqual({ direct: false, targetId: '123' })
		expect(parseKookConversationId('direct:user:with:colon')).toEqual({
			direct: true,
			targetId: 'user:with:colon',
		})
		expect(() => parseKookConversationId('123')).toThrow(/Invalid/)
	})

	it('conforms to the shared transport capability contract', () => {
		assertTransportConformance(KOOK_TRANSPORT_CAPABILITIES, encodeKookBlock)
		expect(KOOK_TRANSPORT_CAPABILITIES.blocks).toContain('text')
	})
})

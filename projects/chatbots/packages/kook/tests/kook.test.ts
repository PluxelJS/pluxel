import { describe, expect, it } from 'vitest'
import { createKookClient, KOOK_ENDPOINTS } from '../src/api/index.ts'
import {
	encodeKookBlock,
	KookBot,
	KookEventObservers,
	KOOK_TRANSPORT_CAPABILITIES,
	normalizeKookEvent,
	parseKookConversationId,
	type KookEvent,
} from '../src/index.ts'
import { assertTransportConformance } from '../../../test/transport-conformance.ts'

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

describe('KOOK adapter contracts', () => {
	it('puts native API on Bot prototype and framework helpers only under $', async () => {
		const requests: Request[] = []
		const options = {
			id: 'community',
			token: 'vault-secret',
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push(new Request(input, init))
				return Response.json({ code: 0, message: 'ok', data: { msg_id: 'sent-1' } })
			},
			logger: { info() {}, warn() {} },
		} satisfies ConstructorParameters<typeof KookBot>[0]
		const first = new KookBot(options)
		const second = new KookBot(options)

		expect(first.sendMessage).toBe(second.sendMessage)
		expect(Object.hasOwn(first, 'sendMessage')).toBe(false)
		expect('$raw' in first).toBe(false)
		expect('$tool' in first).toBe(false)
		expect(JSON.stringify(first)).not.toContain('vault-secret')
		await first.sendMessage({ target_id: 'channel-1', content: 'hello' })
		expect(await requests[0]?.json()).toMatchObject({ content: 'hello' })
		expect(first.$.channel('channel-1').target_id).toBe('channel-1')
	})

	it('exposes the complete v3 endpoint catalog without duplicate method names', () => {
		expect(KOOK_ENDPOINTS).toHaveLength(84)
		expect(new Set(KOOK_ENDPOINTS.map(([name]) => name)).size).toBe(KOOK_ENDPOINTS.length)
	})

	it('dispatches typed GET and POST methods through the shared authenticated client', async () => {
		const requests: Request[] = []
		const client = createKookClient({
			token: 'vault-secret',
			fetch: async (input, init) => {
				const request = new Request(input, init)
				requests.push(request)
				return Response.json({ code: 0, message: 'ok', data: { items: [] } })
			},
		})
		const second = createKookClient({ token: 'vault-secret', fetch: async () => Response.json({}) })
		expect(Object.getPrototypeOf(client).sendMessage).toBe(
			Object.getPrototypeOf(second).sendMessage,
		)

		await client.getGuildList({ page: 2, page_size: 20 })
		await client.sendMessage({ target_id: 'channel-1', content: 'hello' })

		expect(requests[0]?.url).toContain('/api/v3/guild/list?page=2&page_size=20')
		expect(requests[0]?.headers.get('authorization')).toBe('Bot vault-secret')
		expect(requests[1]?.method).toBe('POST')
		expect(await requests[1]?.json()).toMatchObject({ target_id: 'channel-1', content: 'hello' })
	})

	it('provides stateful conversation tools without leaking platform state into ChatMessage', async () => {
		const payloads: unknown[] = []
		const client = createKookClient({
			token: 'vault-secret',
			fetch: async (input, init) => {
				payloads.push(await new Request(input, init).json())
				return Response.json({ code: 0, message: 'ok', data: { msg_id: 'message-42' } })
			},
		})
		const conversation = client.$tool.createConversation('channel-1', { type: 9 })

		await conversation.reply('message-1', 'hello')

		expect(conversation.lastMessageId).toBe('message-42')
		expect(payloads[0]).toMatchObject({
			target_id: 'channel-1',
			content: 'hello',
			quote: 'message-1',
			type: 9,
		})
	})

	it('normalizes group KMarkdown into a stable chat message', () => {
		expect(normalizeKookEvent(event(), 'bot-1')).toMatchObject({
			id: 'message-1',
			platform: 'kook',
			accountId: 'default',
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

	it('exposes raw KOOK events and only advertises encodable blocks', async () => {
		assertTransportConformance(KOOK_TRANSPORT_CAPABILITIES, encodeKookBlock)
		const observers = new KookEventObservers()
		const seen: string[] = []
		observers.register('platform-feature', (raw) => void seen.push(raw.msg_id))
		await observers.dispatch(event(), new AbortController().signal, () => {})
		expect(seen).toEqual(['message-1'])
	})
})

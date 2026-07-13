import { describe, expect, it, vi } from 'vitest'
import { createRuntimeContext } from '@pluxel/runtime/test'
import { createKookClient, KOOK_ENDPOINTS } from '../src/api/index.ts'
import { KookBot } from '../src/bot.ts'
import {
	encodeKookBlock,
	KOOK_TRANSPORT_CAPABILITIES,
	normalizeKookEvent,
	parseKookConversationId,
} from '../src/codec.ts'
import { dispatchKookEvent } from '../src/events.dispatch.ts'
import { createKookPluginEvents } from '../src/events.factory.ts'
import { KOOK_NOTICE_TYPES } from '../src/events.inventory.ts'
import type { KookEvent } from '../src/protocol.ts'
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
	it('delays later requests after an HTTP Retry-After response', async () => {
		vi.useFakeTimers()
		const fetch = vi
			.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
			.mockResolvedValueOnce(
				Response.json(
					{ code: 429, message: 'rate limited', data: null },
					{ status: 429, headers: { 'retry-after': '2' } },
				),
			)
			.mockResolvedValueOnce(Response.json({ code: 0, message: 'ok', data: { items: [] } }))
		const client = createKookClient({ token: 'secret', fetch })

		try {
			expect(await client.getGuildList()).toMatchObject({ ok: false, code: 429 })
			const next = client.getGuildList()
			await Promise.resolve()
			expect(fetch).toHaveBeenCalledTimes(1)
			await vi.advanceTimersByTimeAsync(2_000)
			await expect(next).resolves.toMatchObject({ ok: true })
			expect(fetch).toHaveBeenCalledTimes(2)
		} finally {
			vi.useRealTimers()
		}
	})

	it('puts native API on Bot prototype and framework helpers only under $', async () => {
		const runtime = createRuntimeContext()
		const requests: Request[] = []
		const options = {
			id: 'community',
			ctx: runtime.ctx,
			token: 'vault-secret',
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push(new Request(input, init))
				return Response.json({ code: 0, message: 'ok', data: { msg_id: 'sent-1' } })
			},
		} satisfies ConstructorParameters<typeof KookBot>[0]
		const first = new KookBot(options)
		const second = new KookBot(options)
		const standalone = createKookClient({ token: 'vault-secret', fetch: options.fetch })

		expect(first.sendMessage).toBe(second.sendMessage)
		expect(first.sendMessage).toBe(standalone.sendMessage)
		expect(Object.hasOwn(first, 'sendMessage')).toBe(false)
		expect(Object.hasOwn(KookBot.prototype, 'sendMessage')).toBe(false)
		expect('$raw' in first).toBe(false)
		expect('$tool' in first).toBe(false)
		expect(first.$.info).toEqual({
			id: 'community',
			baseUrl: 'https://www.kookapp.cn',
			apiPrefix: '/api/v3',
		})
		expect(Object.isFrozen(first.$.info)).toBe(true)
		expect(Object.isFrozen(first.$.status)).toBe(true)
		expect(Object.isFrozen(first.$.status.gateway)).toBe(true)
		expect(JSON.stringify(first)).not.toContain('vault-secret')
		await first.sendMessage({ target_id: 'channel-1', content: 'hello' })
		expect(await requests[0]?.json()).toMatchObject({ content: 'hello' })
		expect(first.$.channel('channel-1').target_id).toBe('channel-1')
		await runtime.dispose()
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

	it('exposes finite per-Bot and aggregate EvtChannel properties', async () => {
		assertTransportConformance(KOOK_TRANSPORT_CAPABILITIES, encodeKookBlock)
		const runtime = createRuntimeContext()
		const bot = new KookBot({
			id: 'events',
			ctx: runtime.ctx,
			token: 'secret',
		})
		const aggregate = createKookPluginEvents(runtime.ctx)
		const localSeen: string[] = []
		const aggregateSeen: string[] = []
		bot.events.event.on(() => {
			throw new Error('isolated raw listener')
		})
		bot.events.group_message.on((raw) => void localSeen.push(raw.msg_id))
		aggregate.message.on((source, raw) => void aggregateSeen.push(`${source.id}:${raw.msg_id}`))

		await dispatchKookEvent(bot, bot.events, aggregate, event(), new AbortController().signal)

		expect(Object.keys(bot.events)).toEqual([
			'event',
			'message',
			'group_message',
			'private_message',
			'notice',
			'unknown_notice',
			...KOOK_NOTICE_TYPES,
		])
		expect(localSeen).toEqual(['message-1'])
		expect(aggregateSeen).toEqual(['events:message-1'])

		let clicked = ''
		bot.events.message_btn_click.on((notice) => {
			clicked = notice.extra.body.value
		})
		await dispatchKookEvent(
			bot,
			bot.events,
			aggregate,
			event({
				type: 255,
				extra: { type: 'message_btn_click', body: { value: 'confirm' } },
			}),
			new AbortController().signal,
		)
		expect(clicked).toBe('confirm')
		bot.$.destroy()
		await runtime.dispose()
		expect(bot.events.message_btn_click.count()).toBe(0)
	})
})

import { describe, expect, it, vi } from 'vitest'
import { createRuntimeContext } from '@pluxel/runtime/test'
import wretch from 'wretch'
import { createKookClient, KOOK_ENDPOINTS } from '../src/api/index.ts'
import { KookBot } from '../src/bot/bot.ts'
import type { KookBotManager } from '../src/bot/manager.ts'
import { dispatchKookEvent } from '../src/bot/events.dispatch.ts'
import { createKookPluginEvents } from '../src/bot/events.factory.ts'
import { KOOK_NOTICE_TYPES } from '../src/bot/events.inventory.ts'
import type { KookEvent } from '../src/bot/events.types.ts'
import { createKookGatewaySnapshot } from '../src/bot/gateway.ts'
import { attachKookWorkbenchState } from '../src/workbench/service.ts'

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
		const client = createKookClient({
			http: wretch().fetchPolyfill(fetch),
			token: 'secret',
		})

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
		const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(new Request(input, init))
			return Response.json({ code: 0, message: 'ok', data: { msg_id: 'sent-1' } })
		}
		const options = {
			id: 'community',
			ctx: runtime.ctx,
			http: wretch().fetchPolyfill(fetch),
			token: 'vault-secret',
		} satisfies ConstructorParameters<typeof KookBot>[0]
		const first = new KookBot(options)
		const second = new KookBot(options)
		const standalone = createKookClient({
			http: options.http,
			token: 'vault-secret',
		})

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
			http: wretch().fetchPolyfill(async (input, init) => {
				const request = new Request(input, init)
				requests.push(request)
				return Response.json({ code: 0, message: 'ok', data: { items: [] } })
			}),
			token: 'vault-secret',
		})
		const second = createKookClient({
			http: wretch().fetchPolyfill(async () => Response.json({})),
			token: 'vault-secret',
		})
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
		const runtime = createRuntimeContext()
		const payloads: unknown[] = []
		const bot = new KookBot({
			id: 'conversation',
			ctx: runtime.ctx,
			http: wretch().fetchPolyfill(async (input, init) => {
				payloads.push(await new Request(input, init).json())
				return Response.json({ code: 0, message: 'ok', data: { msg_id: 'message-42' } })
			}),
			token: 'vault-secret',
		})
		const conversation = bot.$.channel('channel-1', { type: 9 })

		await conversation.reply('message-1', 'hello')

		expect(conversation.lastMessageId).toBe('message-42')
		expect(payloads[0]).toMatchObject({
			target_id: 'channel-1',
			content: 'hello',
			quote: 'message-1',
			type: 9,
		})
		bot.$.destroy()
		await runtime.dispose()
	})

	it('exposes finite per-Bot and aggregate EvtChannel properties', async () => {
		const runtime = createRuntimeContext()
		const bot = new KookBot({
			id: 'events',
			ctx: runtime.ctx,
			http: wretch(),
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

describe('KOOK Workbench state', () => {
	it('publishes a bounded native diagnostic snapshot and detaches on abort', () => {
		const listeners = new Set<() => void>()
		const emptyGateway = createKookGatewaySnapshot()
		const manager = {
			listAccounts: () => [
				{
					config: {
						id: 'community',
						token: 'super-secret-token',
						apiBase: 'https://www.kookapp.cn',
					},
					bot: {
						$: {
							status: {
								phase: 'online',
								botId: '100',
								username: 'community-bot',
								lastError: null as string | null,
								startedAt: 1,
								connectedAt: 2,
								updatedAt: 3,
								gateway: createKookGatewaySnapshot({
									phase: 'online',
									lastSequence: 42,
									counters: { ...emptyGateway.counters, eventsReceived: 8 },
									timestamps: { ...emptyGateway.timestamps, lastEventAt: 4 },
								}),
							},
						},
					},
				},
			],
			subscribe: (listener: () => void) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
		} as unknown as KookBotManager
		const controller = new AbortController()
		const emit = vi.fn()
		attachKookWorkbenchState(manager, { emit, signal: controller.signal })

		expect(emit).toHaveBeenCalledWith('snapshot', {
			accounts: [
				expect.objectContaining({
					id: 'community',
					tokenPreview: 'supe••••oken',
					phase: 'online',
					diagnostics: expect.objectContaining({
						gatewayPhase: 'online',
						lastSequence: 42,
						eventsReceived: 8,
						lastEventAt: 4,
					}),
				}),
			],
		})
		for (const listener of listeners) listener()
		expect(emit).toHaveBeenCalledTimes(2)
		controller.abort()
		expect(listeners.size).toBe(0)
	})
})

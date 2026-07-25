import { describe, expect, it, vi } from 'vitest'
import { createRuntimeContext } from '@pluxel/runtime/test'
import wretch from 'wretch'
import { createTelegramClient, TELEGRAM_ENDPOINTS, TELEGRAM_UPDATE_KEYS } from '../src/api/index.ts'
import { dispatchTelegramUpdate } from '../src/bot/events.dispatch.ts'
import { createTelegramPluginEvents } from '../src/bot/events.factory.ts'
import { TelegramBot } from '../src/index.ts'
import type { TelegramBotManager } from '../src/bot/manager.ts'
import { attachTelegramWorkbenchState } from '../src/workbench/service.ts'

describe('Telegram API client', () => {
	it('delays later requests after Telegram retry_after without replaying the failed call', async () => {
		vi.useFakeTimers()
		const fetch = vi
			.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
			.mockResolvedValueOnce(
				Response.json(
					{ ok: false, description: 'Too Many Requests', parameters: { retry_after: 2 } },
					{ status: 429 },
				),
			)
			.mockResolvedValueOnce(
				Response.json({
					ok: true,
					result: { id: 1, is_bot: true, first_name: 'Bot' },
				}),
			)
		const client = createTelegramClient({
			http: wretch().fetchPolyfill(fetch),
			token: 'secret',
		})

		try {
			await expect(client.getMe()).rejects.toThrow('Too Many Requests')
			const next = client.getMe()
			await Promise.resolve()
			expect(fetch).toHaveBeenCalledTimes(1)
			await vi.advanceTimersByTimeAsync(1_999)
			expect(fetch).toHaveBeenCalledTimes(1)
			await vi.advanceTimersByTimeAsync(1)
			await expect(next).resolves.toMatchObject({ id: 1 })
			expect(fetch).toHaveBeenCalledTimes(2)
		} finally {
			vi.useRealTimers()
		}
	})

	it('puts GramIO methods on Bot prototype and keeps raw calls under $', async () => {
		const runtime = createRuntimeContext()
		const requests: Request[] = []
		const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(new Request(input, init))
			return Response.json({ ok: true, result: { message_id: 1 } })
		}
		const options = {
			id: 'notifications',
			ctx: runtime.ctx,
			http: wretch().fetchPolyfill(fetch),
			token: 'secret',
		} satisfies ConstructorParameters<typeof TelegramBot>[0]
		const first = new TelegramBot(options)
		const second = new TelegramBot(options)
		const standalone = createTelegramClient({
			http: options.http,
			token: 'secret',
		})

		expect(first.sendMessage).toBe(second.sendMessage)
		expect(first.sendMessage).toBe(standalone.sendMessage)
		expect(Object.hasOwn(first, 'sendMessage')).toBe(false)
		expect(Object.hasOwn(TelegramBot.prototype, 'sendMessage')).toBe(false)
		expect('call' in first).toBe(false)
		expect(first.$.info).toEqual({ id: 'notifications', apiBase: 'https://api.telegram.org' })
		expect(Object.isFrozen(first.$.info)).toBe(true)
		expect(Object.isFrozen(first.$.status)).toBe(true)
		expect(Object.isFrozen(first.$.status.polling)).toBe(true)
		expect(JSON.stringify(first)).not.toContain('secret')
		await first.sendMessage({ chat_id: 1, text: 'hello' })
		expect(await requests[0]?.json()).toEqual({ chat_id: 1, text: 'hello' })
		await runtime.dispose()
	})

	it('publishes bounded polling diagnostics only when an update arrives', async () => {
		const runtime = createRuntimeContext()
		let polls = 0
		const onStatus = vi.fn()
		const bot = new TelegramBot({
			id: 'diagnostics',
			ctx: runtime.ctx,
			http: wretch().fetchPolyfill(async (input, init) => {
				const method = String(input).split('/').at(-1)
				if (method === 'getMe')
					return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: 'Bot' } })
				if (polls++ === 0)
					return Response.json({
						ok: true,
						result: [
							{
								update_id: 9,
								message: {
									message_id: 1,
									date: 1,
									chat: { id: 1, type: 'private' },
									text: 'hello',
								},
							},
						],
					})
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
						once: true,
					})
				})
			}),
			token: 'secret',
			onStatus,
		})

		await bot.$.start()
		await vi.waitFor(() => expect(bot.$.status.polling.lastUpdateId).toBe(9))
		expect(bot.$.status.polling).toMatchObject({
			offset: 10,
			consecutiveFailures: 0,
			currentBackoffMs: 0,
		})
		expect(bot.$.status.polling.lastUpdateAt).not.toBeNull()
		expect(onStatus.mock.calls.at(-1)?.[0].polling.lastUpdateId).toBe(9)
		bot.$.destroy()
		await runtime.dispose()
	})

	it('advances polling offsets only after inbound consumers accept an update', async () => {
		vi.useFakeTimers()
		const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
		const runtime = createRuntimeContext()
		const consumeUpdate = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error('queue full'))
			.mockResolvedValue(undefined)
		const offsets: string[] = []
		let polls = 0
		const update = {
			update_id: 9,
			message: {
				message_id: 1,
				date: 1,
				chat: { id: 1, type: 'private' },
				text: 'hello',
			},
		}
		const bot = new TelegramBot({
			id: 'checkpoint',
			ctx: runtime.ctx,
			http: wretch().fetchPolyfill(async (input, init) => {
				const url = new URL(String(input))
				if (url.pathname.endsWith('/getMe'))
					return Response.json({
						ok: true,
						result: { id: 1, is_bot: true, first_name: 'Bot' },
					})
				offsets.push(url.searchParams.get('offset') ?? '')
				if (polls++ < 2) return Response.json({ ok: true, result: [update] })
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
						once: true,
					})
				})
			}),
			token: 'secret',
			consumeUpdate,
		})

		try {
			await bot.$.start()
			await vi.waitFor(() => expect(consumeUpdate).toHaveBeenCalledTimes(1))
			expect(bot.$.status.polling.offset).toBe(0)
			await vi.advanceTimersByTimeAsync(2_000)
			await vi.waitFor(() => expect(bot.$.status.polling.offset).toBe(10))
			expect(offsets.slice(0, 2)).toEqual(['0', '0'])
		} finally {
			bot.$.destroy()
			await runtime.dispose()
			random.mockRestore()
			vi.useRealTimers()
		}
	})

	it('inlines a complete endpoint inventory onto one shared prototype', async () => {
		const requests: Request[] = []
		const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(new Request(input, init))
			return Response.json({ ok: true, result: { id: 1 } })
		}
		const http = wretch().fetchPolyfill(fetch)
		const first = createTelegramClient({ http, token: 'secret' })
		const second = createTelegramClient({ http, token: 'secret' })

		expect(TELEGRAM_ENDPOINTS).toHaveLength(180)
		expect(new Set(TELEGRAM_ENDPOINTS.map(([name]) => name)).size).toBe(TELEGRAM_ENDPOINTS.length)
		expect(Object.getPrototypeOf(first).getMe).toBe(Object.getPrototypeOf(second).getMe)
		await first.getMe()
		await first.$.raw.call('getUpdates', { offset: 42, allowed_updates: ['message'] })
		await first.$.raw.call('sendMessage', { chat_id: 1, text: 'hello' })
		expect(requests[1]?.method).toBe('GET')
		expect(requests[1]?.url).toContain('offset=42')
		expect(requests[1]?.url).toContain('allowed_updates=%5B%22message%22%5D')
		expect(requests[2]?.method).toBe('POST')
		expect(await requests[2]?.json()).toEqual({ chat_id: 1, text: 'hello' })
	})

	it('rejects calls outside the reviewed endpoint allowlist', async () => {
		const client = createTelegramClient({ http: wretch(), token: 'secret' })
		// @ts-expect-error APIMethods is the public compile-time allowlist.
		await expect(client.$.raw.call('futureUnreviewedMethod')).rejects.toThrow(
			'Unknown Telegram endpoint',
		)
	})

	it('encodes GramIO Blob input files as Telegram multipart attachments', async () => {
		let request: Request | undefined
		const client = createTelegramClient({
			http: wretch().fetchPolyfill(async (input, init) => {
				request = new Request(input, init)
				return Response.json({ ok: true, result: { message_id: 1 } })
			}),
			token: 'secret',
		})
		await client.sendPhoto({
			chat_id: 1,
			photo: new Blob(['image'], { type: 'image/png' }),
		})
		const form = await request!.formData()
		expect(form.get('photo')).toBe('attach://file_0')
		expect(form.get('file_0')).toBeInstanceOf(Blob)
	})

	it('exposes generated per-Bot and aggregate EvtChannel properties', async () => {
		const runtime = createRuntimeContext()
		const bot = new TelegramBot({
			id: 'events',
			ctx: runtime.ctx,
			http: wretch(),
			token: 'secret',
		})
		const aggregate = createTelegramPluginEvents(runtime.ctx)
		const localSeen: string[] = []
		const aggregateSeen: string[] = []
		bot.events.update.on(() => {
			throw new Error('isolated raw listener')
		})
		bot.events.message.on((message) => void localSeen.push(message.text ?? ''))
		aggregate.message.on(
			(source, message) => void aggregateSeen.push(`${source.id}:${message.text ?? ''}`),
		)

		await dispatchTelegramUpdate(
			bot,
			bot.events,
			aggregate,
			{
				update_id: 7,
				message: { message_id: 1, date: 1, chat: { id: 1, type: 'private' }, text: 'hello' },
			},
			new AbortController().signal,
		)

		expect(Object.keys(bot.events)).toEqual(['update', ...TELEGRAM_UPDATE_KEYS])
		expect(localSeen).toEqual(['hello'])
		expect(aggregateSeen).toEqual(['events:hello'])
		bot.$.destroy()
		await runtime.dispose()
		expect(bot.events.message.count()).toBe(0)
	})
})

describe('Telegram Workbench state', () => {
	it('publishes an initial bounded snapshot and follows manager changes', () => {
		const listeners = new Set<() => void>()
		const manager = {
			listAccounts: () => [
				{
					config: {
						id: 'notifications',
						token: 'super-secret-token',
						apiBase: 'https://api.telegram.org',
					},
					bot: {
						$: {
							status: {
								phase: 'online',
								botId: '42',
								username: 'notify_bot',
								lastError: null as string | null,
								startedAt: 1,
								connectedAt: 2,
								updatedAt: 3,
								polling: {
									offset: 8,
									consecutiveFailures: 0,
									currentBackoffMs: 0,
									lastPollAt: 4,
									lastUpdateId: 7,
									lastUpdateAt: 5,
								},
							},
						},
					},
				},
			],
			subscribe: (listener: () => void) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
		} as unknown as TelegramBotManager
		const controller = new AbortController()
		const emit = vi.fn()
		const cleanup = attachTelegramWorkbenchState(manager, {
			emit,
			signal: controller.signal,
		})

		expect(emit).toHaveBeenCalledWith(
			'snapshot',
			expect.objectContaining({
				accounts: [
					expect.objectContaining({
						id: 'notifications',
						tokenPreview: 'supe••••oken',
						phase: 'online',
						diagnostics: expect.objectContaining({ offset: 8 }),
					}),
				],
			}),
		)
		for (const listener of listeners) listener()
		expect(emit).toHaveBeenCalledTimes(2)
		cleanup()
		expect(listeners.size).toBe(0)
	})
})

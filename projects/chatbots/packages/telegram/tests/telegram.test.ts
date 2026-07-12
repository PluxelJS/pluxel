import { describe, expect, it, vi } from 'vitest'
import { createRuntimeContext } from '@pluxel/runtime/test'
import { createCapabilityRef, type ChatTransport } from '@repo/chatbots-hub'
import { createTelegramClient, TELEGRAM_ENDPOINTS, TELEGRAM_UPDATE_KEYS } from '../src/api/index.ts'
import { TELEGRAM_TRANSPORT_CAPABILITIES, telegramOutboundPayload } from '../src/codec.ts'
import { createTelegramPluginEvents, dispatchTelegramUpdate } from '../src/events.ts'
import { TelegramBot } from '../src/index.ts'
import { assertTransportConformance } from '../../../test/transport-conformance.ts'

describe('Telegram API client', () => {
	it('puts GramIO methods on Bot prototype and keeps raw calls under $', async () => {
		const runtime = createRuntimeContext()
		const requests: Request[] = []
		const options = {
			id: 'notifications',
			ctx: runtime.ctx,
			token: 'secret',
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push(new Request(input, init))
				return Response.json({ ok: true, result: { message_id: 1 } })
			},
		} satisfies ConstructorParameters<typeof TelegramBot>[0]
		const first = new TelegramBot(options)
		const second = new TelegramBot(options)
		const standalone = createTelegramClient({ token: 'secret', fetch: options.fetch })

		expect(first.sendMessage).toBe(second.sendMessage)
		expect(first.sendMessage).toBe(standalone.sendMessage)
		expect(Object.hasOwn(first, 'sendMessage')).toBe(false)
		expect(Object.hasOwn(TelegramBot.prototype, 'sendMessage')).toBe(false)
		expect('call' in first).toBe(false)
		expect(first.$.info).toEqual({ id: 'notifications', apiBase: 'https://api.telegram.org' })
		expect(Object.isFrozen(first.$.info)).toBe(true)
		expect(JSON.stringify(first)).not.toContain('secret')
		await first.sendMessage({ chat_id: 1, text: 'hello' })
		expect(await requests[0]?.json()).toEqual({ chat_id: 1, text: 'hello' })
		await runtime.dispose()
	})

	it('keeps native Bot capability alive while an optional ChatHub is replaced', async () => {
		const runtime = createRuntimeContext()
		const binding = createCapabilityRef<{
			registerTransport(transport: ChatTransport): () => void
			receive(): Promise<void>
		}>()
		const transports: ChatTransport[] = []
		const dispose = vi.fn()
		const hub = {
			registerTransport(transport: ChatTransport) {
				transports.push(transport)
				return dispose
			},
			async receive() {},
		}
		binding.controller.set(hub)
		const bot = new TelegramBot({
			id: 'notifications',
			ctx: runtime.ctx,
			token: 'secret',
			hub: binding.ref,
			fetch: async (input, init) => {
				const method = String(input).split('/').at(-1)
				if (method === 'getMe')
					return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: 'Bot' } })
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
						once: true,
					})
				})
			},
		})

		await bot.$.start()
		expect(bot.selfInfo).toMatchObject({ id: 1, is_bot: true })
		expect(transports.at(-1)).toMatchObject({
			platform: 'telegram',
			accountId: 'notifications',
		})
		binding.controller.set(undefined)
		expect(dispose).toHaveBeenCalledTimes(1)
		binding.controller.set(hub)
		expect(transports).toHaveLength(2)
		await expect(bot.getMe()).resolves.toMatchObject({ id: 1 })
		bot.$.destroy()
		await runtime.dispose()
	})

	it('inlines a complete endpoint inventory onto one shared prototype', async () => {
		const requests: Request[] = []
		const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(new Request(input, init))
			return Response.json({ ok: true, result: { id: 1 } })
		}
		const first = createTelegramClient({ token: 'secret', fetch })
		const second = createTelegramClient({ token: 'secret', fetch })

		expect(TELEGRAM_ENDPOINTS).toHaveLength(180)
		expect(new Set(TELEGRAM_ENDPOINTS.map(([name]) => name)).size).toBe(TELEGRAM_ENDPOINTS.length)
		expect(Object.getPrototypeOf(first).getMe).toBe(Object.getPrototypeOf(second).getMe)
		await first.getMe()
		await first.call('getUpdates', { offset: 42, allowed_updates: ['message'] })
		await first.call('sendMessage', { chat_id: 1, text: 'hello' })
		expect(requests[1]?.method).toBe('GET')
		expect(requests[1]?.url).toContain('offset=42')
		expect(requests[1]?.url).toContain('allowed_updates=%5B%22message%22%5D')
		expect(requests[2]?.method).toBe('POST')
		expect(await requests[2]?.json()).toEqual({ chat_id: 1, text: 'hello' })
	})

	it('rejects calls outside the reviewed endpoint allowlist', async () => {
		const client = createTelegramClient({ token: 'secret' })
		// @ts-expect-error APIMethods is the public compile-time allowlist.
		await expect(client.call('futureUnreviewedMethod')).rejects.toThrow('Unknown Telegram endpoint')
	})

	it('encodes GramIO Blob input files as Telegram multipart attachments', async () => {
		let request: Request | undefined
		const client = createTelegramClient({
			token: 'secret',
			fetch: async (input, init) => {
				request = new Request(input, init)
				return Response.json({ ok: true, result: { message_id: 1 } })
			},
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
		assertTransportConformance(TELEGRAM_TRANSPORT_CAPABILITIES, telegramOutboundPayload)
		const runtime = createRuntimeContext()
		const bot = new TelegramBot({
			id: 'events',
			ctx: runtime.ctx,
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

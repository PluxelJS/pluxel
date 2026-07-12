import { describe, expect, it, vi } from 'vitest'
import { createCapabilityRef, type ChatTransport } from '@repo/chatbots-hub'
import { createTelegramClient, TELEGRAM_ENDPOINTS } from '../src/api/index.ts'
import { TELEGRAM_TRANSPORT_CAPABILITIES, telegramOutboundPayload } from '../src/codec.ts'
import { TelegramUpdateObservers } from '../src/events.ts'
import { TelegramBot } from '../src/index.ts'
import { assertTransportConformance } from '../../../test/transport-conformance.ts'

describe('Telegram API client', () => {
	it('puts GramIO methods on Bot prototype and keeps raw calls under $', async () => {
		const requests: Request[] = []
		const options = {
			id: 'notifications',
			token: 'secret',
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push(new Request(input, init))
				return Response.json({ ok: true, result: { message_id: 1 } })
			},
			logger: { warn() {} },
		} satisfies ConstructorParameters<typeof TelegramBot>[0]
		const first = new TelegramBot(options)
		const second = new TelegramBot(options)

		expect(first.sendMessage).toBe(second.sendMessage)
		expect(Object.hasOwn(first, 'sendMessage')).toBe(false)
		expect('call' in first).toBe(false)
		expect(JSON.stringify(first)).not.toContain('secret')
		await first.sendMessage({ chat_id: 1, text: 'hello' })
		expect(await requests[0]?.json()).toEqual({ chat_id: 1, text: 'hello' })
	})

	it('keeps native Bot capability alive while an optional ChatHub is replaced', async () => {
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
			token: 'secret',
			hub: binding.ref,
			logger: { warn() {} },
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

	it('keeps raw update extensions isolated and matches advertised transport blocks', async () => {
		assertTransportConformance(TELEGRAM_TRANSPORT_CAPABILITIES, telegramOutboundPayload)
		const observers = new TelegramUpdateObservers()
		const seen: number[] = []
		observers.register('platform-feature', (update) => void seen.push(update.update_id))
		await observers.dispatch({ update_id: 7 }, new AbortController().signal, () => {})
		expect(seen).toEqual([7])
	})
})

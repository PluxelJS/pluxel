import { describe, expect, it } from 'vitest'
import {
	chat,
	ChatRouter,
	normalizeContent,
	planChatDelivery,
	type ChatMessage,
} from '../src/index.ts'

const message = (id: string, conversationId = 'room'): ChatMessage => ({
	id,
	platform: 'test',
	accountId: 'default',
	conversation: { id: conversationId, kind: 'group' },
	actor: { id: 'user' },
	content: [{ type: 'text', text: id }],
	text: id,
	createdAt: Date.now(),
})

describe('ChatRouter', () => {
	it('rejects incomplete and duplicate platform account registrations', () => {
		const router = new ChatRouter()
		expect(() =>
			router.registerTransport({
				platform: 'test',
				accountId: '',
				async send() {
					return { messageId: 'x' }
				},
			}),
		).toThrow('non-empty')
		const transport = {
			platform: 'test',
			accountId: 'primary',
			async send() {
				return { messageId: 'x' }
			},
		}
		router.registerTransport(transport)
		expect(() => router.registerTransport({ ...transport })).toThrow('already registered')
	})

	it('orders handlers and stops propagation', async () => {
		const router = new ChatRouter()
		const seen: string[] = []
		router.registerTransport({
			platform: 'test',
			accountId: 'default',
			async send() {
				return { messageId: 'sent' }
			},
		})
		router.registerHandler({
			id: 'late',
			priority: 20,
			handle: () => {
				seen.push('late')
			},
		})
		router.registerHandler({
			id: 'claim',
			priority: 10,
			handle: () => {
				seen.push('claim')
				return 'stop'
			},
		})
		await router.receive(message('1'))
		expect(seen).toEqual(['claim'])
	})

	it('deduplicates messages and serializes a conversation', async () => {
		const router = new ChatRouter()
		const seen: string[] = []
		router.registerTransport({
			platform: 'test',
			accountId: 'default',
			async send() {
				return { messageId: 'sent' }
			},
		})
		router.registerHandler({
			id: 'work',
			async handle({ message: inbound }) {
				await new Promise((resolve) => setTimeout(resolve, inbound.id === '1' ? 10 : 0))
				seen.push(inbound.id)
			},
		})
		await Promise.all([
			router.receive(message('1')),
			router.receive(message('2')),
			router.receive(message('1')),
		])
		expect(seen).toEqual(['1', '2'])
	})

	it('does not collide ids containing transport separators', async () => {
		const router = new ChatRouter()
		const seen: string[] = []
		for (const platform of ['a', 'a:b'])
			router.registerTransport({
				platform,
				accountId: 'default',
				async send() {
					return { messageId: 'sent' }
				},
			})
		router.registerHandler({
			id: 'seen',
			handle: ({ message: inbound }) => void seen.push(inbound.platform),
		})
		await router.receive({ ...message('d', 'b:c'), platform: 'a' })
		await router.receive({ ...message('d', 'c'), platform: 'a:b' })
		expect(seen).toEqual(['a', 'a:b'])
	})

	it('routes and deduplicates independently for bot accounts on one platform', async () => {
		const router = new ChatRouter()
		const sent: string[] = []
		const seen: string[] = []
		for (const accountId of ['primary', 'secondary'])
			router.registerTransport({
				platform: 'test',
				accountId,
				async send() {
					sent.push(accountId)
					return { messageId: `${accountId}-reply` }
				},
			})
		router.registerHandler({
			id: 'reply',
			async handle({ message: inbound, reply }) {
				seen.push(inbound.accountId)
				await reply('ok')
			},
		})

		await router.receive({ ...message('same'), accountId: 'primary' })
		await router.receive({ ...message('same'), accountId: 'secondary' })

		expect(seen).toEqual(['primary', 'secondary'])
		expect(sent).toEqual(['primary', 'secondary'])
		expect(router.snapshot().deduplicated).toBe(0)
	})

	it('expires dedupe entries and invalidates cached handler plans', async () => {
		let now = 1_000
		const router = new ChatRouter(undefined, { dedupeWindowMs: 100, now: () => now })
		const seen: string[] = []
		router.registerTransport({
			platform: 'test',
			accountId: 'default',
			async send() {
				return { messageId: 'sent' }
			},
		})
		const disposeLate = router.registerHandler({
			id: 'late',
			priority: 20,
			handle: () => void seen.push('late'),
		})
		router.listHandlers()
		router.registerHandler({
			id: 'early',
			priority: 10,
			handle: () => void seen.push('early'),
		})

		await router.receive(message('same'))
		await router.receive(message('same'))
		now += 101
		disposeLate()
		await router.receive(message('same'))

		expect(seen).toEqual(['early', 'late', 'early'])
		expect(router.snapshot().deduplicated).toBe(1)
	})

	it('aborts and drains active work when closed', async () => {
		const router = new ChatRouter()
		let drained = false
		router.registerTransport({
			platform: 'test',
			accountId: 'default',
			async send() {
				return { messageId: 'sent' }
			},
		})
		router.registerHandler({
			id: 'active',
			async handle({ signal }) {
				await new Promise<void>((resolve) => {
					signal.addEventListener(
						'abort',
						() =>
							setTimeout(() => {
								drained = true
								resolve()
							}, 5),
						{ once: true },
					)
				})
			},
		})
		const active = router.receive(message('active'))
		await new Promise((resolve) => setTimeout(resolve, 0))
		await router.close()

		expect(drained).toBe(true)
		await active
		await expect(router.receive(message('after-close'))).rejects.toThrow('closed')
	})

	it('plans rich delivery against transport capabilities', () => {
		const transport = {
			platform: 'text-only',
			accountId: 'default',
			capabilities: { blocks: ['text'] as const, mixedContent: false },
			async send() {
				return { messageId: 'sent' }
			},
		}
		const requests = planChatDelivery(transport, {
			conversationId: 'room',
			content: [
				{ type: 'text', text: 'caption' },
				{ type: 'image', url: 'https://example.test/image.png', alt: 'preview' },
			],
		})
		expect(requests.map((request) => request.content)).toEqual([
			[{ type: 'text', text: 'caption\n[image] preview' }],
		])
		expect(() =>
			planChatDelivery(transport, {
				conversationId: 'room',
				content: [{ type: 'image', url: 'https://example.test/image.png' }],
				mode: 'strict',
			}),
		).toThrow(/does not support image/)
	})

	it('validates unsupported blocks even when mixed delivery is enabled', () => {
		const transport = {
			platform: 'mixed',
			accountId: 'default',
			capabilities: { blocks: ['text', 'image'] as const, mixedContent: true },
			async send() {
				return { messageId: 'sent' }
			},
		}
		const input = {
			conversationId: 'room',
			content: [{ type: 'video' as const, url: 'https://example.test/clip.mp4', name: 'clip' }],
		}
		expect(() => planChatDelivery(transport, { ...input, mode: 'strict' })).toThrow(
			/does not support video/,
		)
		expect(planChatDelivery(transport, input)[0]?.content).toEqual([
			{ type: 'text', text: '[video] clip' },
		])
	})

	it('splits over-limit text without breaking Unicode or reply semantics', () => {
		const transport = {
			platform: 'limited',
			accountId: 'default',
			capabilities: { blocks: ['text', 'image'] as const, mixedContent: true, maxTextLength: 5 },
			async send() {
				return { messageId: 'sent' }
			},
		}
		const requests = planChatDelivery(transport, {
			conversationId: 'room',
			replyToId: 'source',
			content: [
				{ type: 'image', url: 'https://example.test/image.png' },
				{ type: 'text', text: 'ab😀cdefgh' },
			],
		})
		const text = requests
			.flatMap((request) => normalizeContent(request.content))
			.filter((block) => block.type === 'text')
			.map((block) => block.text)
		expect(text.join('')).toBe('ab😀cdefgh')
		expect(text.every((chunk) => chunk.length <= 5)).toBe(true)
		expect(text.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true)
		expect(requests.map((request) => request.replyToId)).toEqual(['source', undefined])
	})

	it('isolates platform-specific atomic blocks inside mixed transports', () => {
		const requests = planChatDelivery(
			{
				platform: 'mixed-with-files',
				accountId: 'default',
				capabilities: {
					blocks: ['text', 'mention', 'file'],
					mixedContent: true,
					atomicBlocks: ['file'],
				},
				async send() {
					return { messageId: 'sent' }
				},
			},
			{
				conversationId: 'room',
				content: [
					{ type: 'text', text: 'before' },
					{ type: 'mention', actorId: '1' },
					{ type: 'file', url: 'file.zip' },
					{ type: 'text', text: 'after' },
				],
			},
		)
		expect(requests.map((request) => normalizeContent(request.content))).toEqual([
			[
				{ type: 'text', text: 'before' },
				{ type: 'mention', actorId: '1' },
			],
			[{ type: 'file', url: 'file.zip' }],
			[{ type: 'text', text: 'after' }],
		])
	})

	it('delivers explicit batches with fail-fast or best-effort semantics', async () => {
		const router = new ChatRouter()
		const sent: string[] = []
		router.registerTransport({
			platform: 'test',
			accountId: 'default',
			async send(request) {
				const text =
					typeof request.content === 'string'
						? request.content
						: request.content[0]?.type === 'text'
							? request.content[0].text
							: ''
				if (text === 'bad') throw new Error('rejected')
				sent.push(text)
				return { messageId: `sent-${text}` }
			},
		})

		const result = await router.send(
			{ platform: 'test', accountId: 'default', conversationId: 'room' },
			chat.batchBestEffort('first', 'bad', 'last'),
		)
		expect(sent).toEqual(['first', 'last'])
		expect(result.messageIds).toEqual(['sent-first', 'sent-last'])
		expect(result.failures).toEqual([{ index: 1, message: 'rejected' }])

		await expect(
			router.send(
				{ platform: 'test', accountId: 'default', conversationId: 'room' },
				chat.batch('first', 'bad', 'last'),
			),
		).rejects.toThrow('rejected')
	})
})

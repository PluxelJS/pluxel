import { describe, expect, it } from 'vitest'
import { chat, normalizeContent, type ChatMessage } from '@repo/chatbots-contracts'
import { planChatDelivery } from '../src/delivery.ts'
import { ChatRouter } from '../src/router.ts'

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

	it('reports isolated handler and observer failures', async () => {
		const router = new ChatRouter()
		router.registerTransport({
			platform: 'test',
			accountId: 'default',
			async send() {
				return { messageId: 'sent' }
			},
		})
		router.registerObserver('broken-observer', () => {
			throw new Error('observer failed')
		})
		router.registerHandler({
			id: 'broken-handler',
			handle: () => {
				throw new Error('handler failed')
			},
		})

		await router.receive(message('isolated'))
		expect(router.snapshot()).toMatchObject({ failedHandlers: 1, failedObservers: 1 })
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

	it('shares in-flight duplicate results and rolls failed dispatches back', async () => {
		const router = new ChatRouter()
		const transport = {
			platform: 'test',
			accountId: 'default',
			async send() {
				return { messageId: 'sent' }
			},
		}
		const dispose = router.registerTransport(transport)
		const first = router.receive(message('retryable'))
		const duplicate = router.receive(message('retryable'))
		dispose()

		const failed = await Promise.allSettled([first, duplicate])
		expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected'])
		expect(router.snapshot().deduplicated).toBe(1)

		router.registerTransport(transport)
		const seen: string[] = []
		router.registerHandler({
			id: 'retry',
			handle: ({ message: inbound }) => void seen.push(inbound.id),
		})
		await router.receive(message('retryable'))
		expect(seen).toEqual(['retryable'])
	})

	it('does not commit dedupe state for cancelled dispatches', async () => {
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
			id: 'seen',
			handle: ({ message: inbound }) => void seen.push(inbound.id),
		})
		const controller = new AbortController()
		controller.abort(new Error('cancelled'))
		await expect(router.receive(message('cancelled'), controller.signal)).rejects.toThrow(
			'cancelled',
		)
		await router.receive(message('cancelled'))
		expect(seen).toEqual(['cancelled'])
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
		const cancelled = active.catch((error: unknown) => error)
		await new Promise((resolve) => setTimeout(resolve, 0))
		await router.close()

		expect(drained).toBe(true)
		expect(await cancelled).toMatchObject({ message: 'Chat router is closed' })
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
		expect(router.snapshot().failedSends).toBe(2)
	})

	it('keeps each logical send contiguous within one conversation', async () => {
		const router = new ChatRouter()
		const firstStarted = deferred<void>()
		const releaseFirst = deferred<void>()
		const sent: string[] = []
		router.registerTransport({
			platform: 'test',
			accountId: 'default',
			async send(request) {
				const text = normalizeContent(request.content)[0]
				const value = text?.type === 'text' ? text.text : ''
				sent.push(value)
				if (value === 'a1') {
					firstStarted.resolve()
					await releaseFirst.promise
				}
				return { messageId: value }
			},
		})
		const address = { platform: 'test', accountId: 'default', conversationId: 'room' }
		const first = router.send(address, chat.batch('a1', 'a2'))
		await firstStarted.promise
		const second = router.send(address, chat.batch('b1', 'b2'))
		await Promise.resolve()
		expect(sent).toEqual(['a1'])
		releaseFirst.resolve()
		await Promise.all([first, second])

		expect(sent).toEqual(['a1', 'a2', 'b1', 'b2'])
		expect(router.snapshot()).toMatchObject({
			outboundConversations: 0,
			pendingSends: 0,
			runningSends: 0,
		})
	})

	it('keeps unrelated outbound conversations concurrent', async () => {
		const router = new ChatRouter()
		const started = new Set<string>()
		const bothStarted = deferred<void>()
		const release = deferred<void>()
		router.registerTransport({
			platform: 'test',
			accountId: 'default',
			async send(request) {
				started.add(request.conversationId)
				if (started.size === 2) bothStarted.resolve()
				await release.promise
				return { messageId: request.conversationId }
			},
		})
		const send = (conversationId: string) =>
			router.send({ platform: 'test', accountId: 'default', conversationId }, 'hello')
		const tasks = [send('one'), send('two')]
		await bothStarted.promise
		expect(started).toEqual(new Set(['one', 'two']))
		release.resolve()
		await Promise.all(tasks)
	})

	it('bounds inbound and outbound queues without poisoning retries', async () => {
		const router = new ChatRouter(undefined, {
			maxPendingReceivesPerConversation: 1,
			maxPendingSendsPerConversation: 1,
		})
		const receiveGate = deferred<void>()
		const sendGate = deferred<void>()
		router.registerTransport({
			platform: 'test',
			accountId: 'default',
			async send() {
				await sendGate.promise
				return { messageId: 'sent' }
			},
		})
		router.registerHandler({ id: 'wait', handle: () => receiveGate.promise })

		const firstReceive = router.receive(message('first'))
		await expect(router.receive(message('retry'))).rejects.toThrow('receive queue is full')
		const firstSend = router.send(
			{ platform: 'test', accountId: 'default', conversationId: 'room' },
			'first',
		)
		await expect(
			router.send({ platform: 'test', accountId: 'default', conversationId: 'room' }, 'second'),
		).rejects.toThrow('send queue is full')

		receiveGate.resolve()
		sendGate.resolve()
		await Promise.all([firstReceive, firstSend])
		await router.receive(message('retry'))
		expect(router.snapshot()).toMatchObject({ rejectedReceives: 1, rejectedSends: 1 })
	})

	it('bounds total work across many conversations', async () => {
		const router = new ChatRouter(undefined, {
			maxPendingReceives: 2,
			maxPendingReceivesPerConversation: 2,
			maxPendingSends: 2,
			maxPendingSendsPerConversation: 2,
		})
		const receiveGate = deferred<void>()
		const sendGate = deferred<void>()
		router.registerTransport({
			platform: 'test',
			accountId: 'default',
			async send() {
				await sendGate.promise
				return { messageId: 'sent' }
			},
		})
		router.registerHandler({ id: 'wait', handle: () => receiveGate.promise })

		const receives = [router.receive(message('one', 'one')), router.receive(message('two', 'two'))]
		await expect(router.receive(message('three', 'three'))).rejects.toThrow('receive queue is full')
		const send = (conversationId: string) =>
			router.send({ platform: 'test', accountId: 'default', conversationId }, 'hello')
		const sends = [send('one'), send('two')]
		await expect(send('three')).rejects.toThrow('send queue is full')
		expect(router.snapshot()).toMatchObject({ pendingReceives: 2, pendingSends: 2 })

		receiveGate.resolve()
		sendGate.resolve()
		await Promise.all([...receives, ...sends])
		await Promise.all([router.receive(message('three', 'three')), send('three')])
	})

	it('bounds shutdown when a handler ignores cancellation', async () => {
		const warnings: string[] = []
		const router = new ChatRouter(
			{ debug() {}, warn: (warning) => void warnings.push(warning) },
			{ drainTimeoutMs: 5 },
		)
		router.registerTransport({
			platform: 'test',
			accountId: 'default',
			async send() {
				return { messageId: 'sent' }
			},
		})
		const started = deferred<void>()
		router.registerHandler({
			id: 'stuck',
			async handle() {
				started.resolve()
				await new Promise(() => {})
			},
		})
		void router.receive(message('stuck'))
		await started.promise
		await router.close()

		expect(warnings).toContain('Chat router drain timed out')
		expect(router.snapshot().drainTimeouts).toBe(1)
	})
})

function deferred<Value>() {
	let resolve!: (value: Value | PromiseLike<Value>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

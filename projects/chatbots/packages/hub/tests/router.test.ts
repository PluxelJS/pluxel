import { describe, expect, it } from 'vitest'
import { ChatRouter, type ChatMessage } from '../src/index.ts'

const message = (id: string, conversationId = 'room'): ChatMessage => ({
	id,
	transport: 'test',
	conversation: { id: conversationId, kind: 'group' },
	actor: { id: 'user' },
	content: [{ type: 'text', text: id }],
	text: id,
	createdAt: Date.now(),
})

describe('ChatRouter', () => {
	it('orders handlers and stops propagation', async () => {
		const router = new ChatRouter()
		const seen: string[] = []
		router.registerTransport({
			name: 'test',
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
			name: 'test',
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
})

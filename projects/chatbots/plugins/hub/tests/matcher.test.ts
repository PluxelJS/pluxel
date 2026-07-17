import { describe, expect, it } from 'vitest'
import type { ChatHandlerContext } from '../src/handler.ts'
import { AhoMatcher } from '../src/matcher/aho.ts'
import { ChatMatcherIndex } from '../src/matcher/index.ts'

describe('chat matcher index', () => {
	it('finds overlapping patterns with a compact automaton', () => {
		const matcher = new AhoMatcher(['he', 'she', 'hers'])
		expect(matcher.find('ushers').map((match) => match.pattern)).toEqual(['she', 'he', 'hers'])
	})

	it('orders claim matchers and supports prefix boundaries', async () => {
		const index = new ChatMatcherIndex()
		const seen: string[] = []
		index.register({
			id: 'late',
			patterns: ['/deploy'],
			mode: 'prefix',
			dispatch: 'claim',
			priority: 20,
			onMatch: () => {
				seen.push('late')
			},
		})
		index.register({
			id: 'first',
			patterns: ['/deploy'],
			mode: 'prefix',
			dispatch: 'claim',
			priority: 10,
			onMatch: () => {
				seen.push('first')
				return 'stop'
			},
		})

		await expect(index.dispatch(context('/deploy production'))).resolves.toBe('stop')
		expect(seen).toEqual(['first'])
		await expect(index.dispatch(context('/deployment'))).resolves.toBeUndefined()
	})

	it('runs observe matchers even when a claim stops ownership', async () => {
		const index = new ChatMatcherIndex()
		const seen: string[] = []
		index.register({
			id: 'observe',
			patterns: ['ping'],
			dispatch: 'observe',
			onMatch: () => void seen.push('observe'),
		})
		index.register({
			id: 'claim',
			patterns: ['ping'],
			dispatch: 'claim',
			onMatch: () => 'stop',
		})
		await expect(index.dispatch(context('ping'))).resolves.toBe('stop')
		expect(seen).toEqual(['observe'])
	})

	it('preserves source indices when Unicode case folding expands', () => {
		const matcher = new AhoMatcher([{ pattern: 'İ', value: 'hit' }], true)
		expect(matcher.find('xİy')).toEqual([{ index: 1, end: 2, pattern: 'İ', value: 'hit' }])
	})
})

function context(text: string): ChatHandlerContext {
	return {
		message: {
			id: 'message',
			platform: 'test',
			accountId: 'default',
			conversation: { id: 'room', kind: 'group' },
			actor: { id: 'user' },
			content: [{ type: 'text', text }],
			text,
			createdAt: Date.now(),
		},
		signal: new AbortController().signal,
		reply: async () => ({ messageId: 'reply' }),
		send: async () => ({ messageId: 'send' }),
	}
}

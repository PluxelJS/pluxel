import { expect, it } from 'vitest'
import { redactMessage, transcript } from '../src/backend/ai-transcript'

const assistant = {
	role: 'assistant',
	timestamp: 2,
	stopReason: 'toolUse',
	content: [
		{ type: 'thinking', thinking: '检查共享主题。' },
		{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: '共享/主题.typ' } },
	],
}

it('retains live reasoning, tool progress and the same identities after persisted results', () => {
	const messages = [{ role: 'user', content: '修改主题', timestamp: 1 }, assistant]
	const live = transcript(messages, { running: true, streaming: true })
	expect(live[1]).toMatchObject({
		status: 'running',
		content: [
			{ type: 'reasoning', text: '检查共享主题。' },
			{ type: 'tool-call', toolCallId: 'read-1', status: 'running' },
		],
	})
	const partial = transcript(messages, {
		running: true,
		tools: new Map([['read-1', { status: 'running', result: '已读取前半部分' }]]),
	})
	expect(partial[1]?.content[1]).toMatchObject({ result: '已读取前半部分', status: 'running' })
	const saved = transcript([
		...messages,
		{
			role: 'toolResult',
			toolCallId: 'read-1',
			isError: true,
			content: [{ type: 'text', text: '版本冲突，请重新读取。' }],
		},
	])
	expect(saved).toHaveLength(2)
	expect(saved[1]?.id).toBe(live[1]?.id)
	expect(saved[1]?.content[1]).toMatchObject({
		status: 'error',
		isError: true,
		result: '版本冲突，请重新读取。',
	})
	expect(transcript(messages)[1]?.content[1]).toMatchObject({ status: 'incomplete' })
})

it('keeps an empty live assistant for the first-token indicator and redacts nested output', () => {
	expect(
		transcript([{ role: 'assistant', timestamp: 3, content: [] }], { streaming: true }),
	).toMatchObject([{ role: 'assistant', content: [], status: 'running' }])
	const message = transcript([
		{
			...assistant,
			content: [
				{ type: 'toolCall', id: 'x', name: 'read', arguments: { nested: { key: 'secret' } } },
			],
		},
		{ role: 'toolResult', toolCallId: 'x', content: [{ type: 'text', text: 'secret' }] },
	])[0]!
	const output = redactMessage(message, (text) => text.replaceAll('secret', '[redacted]'))
	expect(JSON.stringify(output)).not.toContain('secret')
	expect(JSON.stringify(message)).toContain('secret')
})

import { describe, expect, it } from 'vitest'
import { fromThreadMessageLike } from '@assistant-ui/react'
import type { AiMessage } from '../src/shared/contracts'
import { toAssistantMessage } from '../src/renderer/assistant-messages'

const nativeMessage = (message: AiMessage) =>
	fromThreadMessageLike(toAssistantMessage(message), 'fallback', {
		type: 'complete',
		reason: 'stop',
	})

describe('assistant-ui message projection', () => {
	it('preserves streamed reasoning and a running tool, with stable identities and parsed arguments', () => {
		const message = nativeMessage({
			id: 'step-1',
			role: 'assistant',
			status: 'running',
			content: [
				{ type: 'reasoning', text: '先读取共享主题。' },
				{
					type: 'tool-call',
					toolCallId: 'read-1',
					toolName: 'read',
					args: { path: '共享/主题/财务函件.typ' },
					argsText: '{"path":"共享/主题/财务函件.typ"}',
					status: 'running',
				},
			],
		})
		expect(message.id).toBe('step-1')
		expect(message.role).toBe('assistant')
		expect(message.content.map((part) => part.type)).toEqual(['reasoning', 'tool-call'])
		expect(message.content[1]).toMatchObject({
			toolCallId: 'read-1',
			args: { path: '共享/主题/财务函件.typ' },
		})
		if (message.role !== 'assistant') throw new Error('Expected assistant message')
		expect(message.status).toEqual({ type: 'running' })
		expect(message.metadata.custom.toolStates).toEqual({ 'read-1': 'running' })
	})

	it('keeps tool failures, exact output and the following answer instead of flattening them', () => {
		const result = { diagnostic: '<error>\n```typst\n#import "missing.typ"\n```' }
		const message = nativeMessage({
			id: 'step-2',
			role: 'assistant',
			status: 'complete',
			content: [
				{
					type: 'tool-call',
					toolCallId: 'compile-1',
					toolName: 'compile_preview',
					args: {},
					argsText: '{}',
					result,
					isError: true,
					status: 'error',
				},
				{ type: 'text', text: '请检查导入路径。' },
			],
		})
		expect(message.content[0]).toMatchObject({ toolCallId: 'compile-1', isError: true, result })
		expect(message.content[1]).toMatchObject({ type: 'text', text: '请检查导入路径。' })
		if (message.role !== 'assistant') throw new Error('Expected assistant message')
		expect(message.metadata.custom.toolStates).toEqual({ 'compile-1': 'error' })
	})

	it('marks a cancelled response incomplete and never adds reasoning to a plain user message', () => {
		const cancelled = nativeMessage({
			id: 'step-3',
			role: 'assistant',
			status: 'cancelled',
			content: [{ type: 'text', text: '正在调整' }],
		})
		if (cancelled.role !== 'assistant') throw new Error('Expected assistant message')
		expect(cancelled.status).toEqual({ type: 'incomplete', reason: 'cancelled' })
		expect(cancelled.content[0]).toMatchObject({
			status: { type: 'incomplete', reason: 'cancelled' },
		})
		const user = nativeMessage({
			id: 'user-1',
			role: 'user',
			content: [{ type: 'text', text: '统一表格主题。' }],
		})
		expect(user.id).toBe('user-1')
		expect(user.content.map((part) => part.type)).toEqual(['text'])
	})

	it('keeps a missing tool result incomplete without inventing a result', () => {
		const message = nativeMessage({
			id: 'step-4',
			role: 'assistant',
			status: 'complete',
			content: [
				{
					type: 'tool-call',
					toolCallId: 'missing-1',
					toolName: 'write',
					args: { path: '排版.typ' },
					argsText: '{"path":"排版.typ"}',
					status: 'incomplete',
				},
			],
		})
		expect(message.content[0]).not.toHaveProperty('result')
		if (message.role !== 'assistant') throw new Error('Expected assistant message')
		expect(message.metadata.custom.toolStates).toEqual({ 'missing-1': 'incomplete' })
	})
})

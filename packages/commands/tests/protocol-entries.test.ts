import { describe, expect, it, vi } from 'vitest'
import type { Command } from '../src/types'

vi.mock('capnweb', () => {
	throw new Error('Cap’n Web is not installed')
})
vi.mock('@modelcontextprotocol/sdk/types.js', () => {
	throw new Error('MCP SDK is not installed')
})

describe('optional protocol dependencies', () => {
	it('loads and calls the kernel and MCP projection without protocol runtimes', async () => {
		const { defineCommand, Result } = await import('../src/index')
		const { toMcp } = await import('../src/mcp')
		const { Type, obj } = await import('../src/typebox')
		const command: Command<{ message: string }, string> = defineCommand({
			name: 'echo',
			description: 'Echo a message.',
			input: obj({ message: Type.String() }),
			execute: ({ message }) => Result.ok(message),
		})
		const tool = toMcp(command)
		expect(await tool.call({ message: 'hello' })).toEqual({
			content: [{ type: 'text', text: '"hello"' }],
		})
	})
})

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
	CallToolRequestSchema,
	CallToolResultSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { Result, defineCommand, type CommandContext } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { toMcp } from '../../src/mcp'

interface NoteContext extends CommandContext {
	readonly actor: string
}

const read = defineCommand({
	name: 'notes.read',
	description: 'Read a note.',
	input: obj({ id: Type.String() }),
	execute({ id }, context: NoteContext) {
		return id === 'missing'
			? Result.err({ code: 'REJECTED' as const, reason: 'not_found', message: 'Missing note' })
			: Result.ok({ id, actor: context.actor })
	},
})

describe('toMcp', () => {
	it('projects a Command through native MCP request handlers without owning a server', async () => {
		const note = toMcp(read)
		const server = new Server(
			{ name: 'notes-test', version: '1.0.0' },
			{ capabilities: { tools: {} } },
		)
		server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [note.tool] }))
		server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
			if (params.name !== note.tool.name) throw new Error('Unknown tool')
			return note.call(params.arguments ?? {}, { actor: 'server' })
		})
		const client = new Client({ name: 'notes-client', version: '1.0.0' })
		const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
		try {
			await server.connect(serverTransport)
			await client.connect(clientTransport)
			const listed = await client.listTools()
			expect(listed.tools).toMatchObject([
				{ name: 'notes.read', description: 'Read a note.', inputSchema: { type: 'object' } },
			])
			const success = await client.callTool({ name: 'notes.read', arguments: { id: 'one' } })
			expect(success).toMatchObject({
				content: [{ type: 'text', text: '{"id":"one","actor":"server"}' }],
			})
			const missing = await client.callTool({ name: 'notes.read', arguments: { id: 'missing' } })
			expect(missing).toMatchObject({
				isError: true,
				content: [
					{
						type: 'text',
						text: '{"code":"REJECTED","message":"Missing note","reason":"not_found"}',
					},
				],
			})
			const invalid = CallToolResultSchema.parse(
				await client.callTool({ name: 'notes.read', arguments: { id: 1 } }),
			)
			expect(invalid).toMatchObject({ isError: true })
			expect(JSON.parse((invalid.content[0] as { text: string }).text)).toMatchObject({
				code: 'INPUT_VALIDATION',
			})
		} finally {
			await client.close()
			await server.close()
		}
	})

	it('hides local causes and rejects values that JSON would silently change', async () => {
		const fail = defineCommand({
			name: 'notes.fail',
			description: 'Fail inside a dependency.',
			input: obj({}),
			execute(): never {
				throw new Error('private dependency detail')
			},
		})
		const unsafe = defineCommand({
			name: 'notes.unsafe',
			description: 'Return unsupported data.',
			input: obj({}),
			execute: () => Result.ok({ hidden: undefined }),
		})
		const failed = await toMcp(fail).call({})
		expect(failed.isError).toBe(true)
		expect((failed.content[0] as { text: string }).text).toBe(
			'{"code":"INTERNAL","message":"Command failed"}',
		)
		const unsupported = await toMcp(unsafe).call({})
		expect(unsupported.isError).toBe(true)
		expect((unsupported.content[0] as { text: string }).text).toBe(
			'{"code":"OUTPUT_ENCODING","message":"Command output is not JSON"}',
		)
	})
})

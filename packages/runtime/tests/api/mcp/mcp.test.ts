import { describe, expect, it } from 'vitest'
import { withRuntimeContext, type Context } from '@pluxel/runtime/test'
import '../../../../runtime-dynamic/src/register'
import { HMR_INTERNAL_API_BASE, HMR_TRANSPORT_PATHS } from '@pluxel/runtime/web/paths'
import { defineOp } from '@pluxel/ops'
import { Type, obj } from '@pluxel/ops/typebox'
import { getHmrMcpHttpHandler } from '../../../src/api/mcp'
import { setHmrRuntimeHandles } from '../../../src/runtime/hmr-handles'

async function createMcpCaller(ctx: Context) {
	const handler = getHmrMcpHttpHandler(ctx)
	let sessionId: string | null = null
	let protocolVersion = '2025-06-18'

	const call = async (body: unknown) => {
		const headers: Record<string, string> = { 'content-type': 'application/json' }
		if (sessionId) headers['mcp-session-id'] = sessionId
		if ((body as any)?.method !== 'initialize') headers['mcp-protocol-version'] = protocolVersion

		const res = await handler(
			new Request(`http://localhost${HMR_INTERNAL_API_BASE}${HMR_TRANSPORT_PATHS.mcp}`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
			}),
		)

		sessionId = res.headers.get('mcp-session-id') ?? sessionId
		protocolVersion = res.headers.get('mcp-protocol-version') ?? protocolVersion

		expect(res.status).toBe(200)
		return await res.json()
	}

	const init = await call({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion,
			clientInfo: { name: 'pluxel-test', version: '0' },
			capabilities: {},
		},
	})

	return { call, init }
}

describe('MCP (mcp-lite) endpoint', () => {
	it('supports initialize, tools/list, tools/call', async () => {
		await withRuntimeContext(async (ctx) => {
			setHmrRuntimeHandles(ctx, {
				hmr: {
					api: {
						waitForBatch: async () => ({
							epoch: 1,
							ok: true,
							changed: [],
							targets: [],
							affected: 0,
							fallbackRoots: 0,
							invalidated: { vite: 0, runner: 0 },
							activeServices: 0,
							plugins: {},
							commitMs: null,
							batchMs: 0.1,
						}),
						waitForStable: async () => ({
							epoch: 2,
							ok: true,
							changed: [],
							targets: [],
							affected: 0,
							fallbackRoots: 0,
							invalidated: { vite: 0, runner: 0 },
							activeServices: 0,
							plugins: {},
							commitMs: null,
							batchMs: 0.2,
						}),
						lastBatch: () => null,
						waitForIdle: async () => {},
					},
				},
			})

			const { call, init } = await createMcpCaller(ctx)
			expect(init.result.serverInfo.name).toBe('pluxel-hmr')

			const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
			const toolNames = new Set((list.result.tools as any[]).map((t) => t.name))

			for (const name of [
				'hmr.waitForBatch',
				'logs.latest',
				'logs.latestText',
				'plugins.list',
				'plugin.status',
				'plugin.config.patch',
				'plugins.status.apply',
				'workspace.resolveEntry',
			]) {
				expect(toolNames.has(name)).toBe(true)
			}

			const logs = await call({
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: { name: 'logs.latest', arguments: { limit: 1 } },
			})
			expect(logs.result.structuredContent).toHaveProperty('lines')
			expect(logs.result.structuredContent).toHaveProperty('meta')

			const logsText = await call({
				jsonrpc: '2.0',
				id: 4,
				method: 'tools/call',
				params: { name: 'logs.latestText', arguments: { limit: 1 } },
			})
			expect(logsText.result.structuredContent).toHaveProperty('text')

			const batch = await call({
				jsonrpc: '2.0',
				id: 5,
				method: 'tools/call',
				params: { name: 'hmr.waitForBatch', arguments: { timeoutMs: 100 } },
			})
			expect(batch.result.structuredContent.epoch).toBe(1)

			const stable = await call({
				jsonrpc: '2.0',
				id: 6,
				method: 'tools/call',
				params: { name: 'hmr.waitForStable', arguments: { timeoutMs: 100, quietMs: 1 } },
			})
			expect(stable.result.structuredContent.epoch).toBe(2)

			const lastBatch = await call({
				jsonrpc: '2.0',
				id: 7,
				method: 'tools/call',
				params: { name: 'hmr.lastBatch', arguments: {} },
			})
			expect(lastBatch.result.structuredContent).toHaveProperty('batch')
		})
	})

	it('refreshes MCP tool projection when ops registry changes', async () => {
		await withRuntimeContext(async (ctx) => {
			const { call, init } = await createMcpCaller(ctx)
			expect(init.result.serverInfo.name).toBe('pluxel-hmr')

			const before = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
			expect(
				(before.result.tools as Array<{ name: string }>).some((tool) => tool.name === 'demo.echo'),
			).toBe(false)

			ctx.ops.register(
				defineOp({
					id: 'demo.echo',
					doc: {
						title: 'Demo Echo',
						description: 'Echo a demo value.',
					},
					input: obj({
						value: Type.String({ description: 'Value to echo back.' }),
					}),
					output: obj({
						value: Type.String(),
					}),
					async run(input) {
						return input
					},
				}),
				{ metadata: { mcp: { name: 'demo.echo' } } },
			)

			const after = await call({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
			expect(
				(after.result.tools as Array<{ name: string }>).some((tool) => tool.name === 'demo.echo'),
			).toBe(true)

			const echo = await call({
				jsonrpc: '2.0',
				id: 4,
				method: 'tools/call',
				params: { name: 'demo.echo', arguments: { value: 'ok' } },
			})
			expect(echo.result.structuredContent).toEqual({ ok: true, value: { value: 'ok' } })
		})
	})
})

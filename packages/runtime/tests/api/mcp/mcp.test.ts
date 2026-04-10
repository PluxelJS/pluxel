import { describe, expect, it } from 'vitest'
import { Context } from '@pluxel/runtime'
import { HMR_INTERNAL_API_BASE, HMR_TRANSPORT_PATHS } from '@pluxel/runtime/web/paths'
import { defineOp, typebox } from '@pluxel/ops'
import { getHmrMcpHttpHandler } from '../../../src/api/mcp'
import { setDevRuntimeHandles } from '../../../src/runtime/dev-handles'

describe('MCP (mcp-lite) endpoint', () => {
	it('supports initialize, tools/list, tools/call', async () => {
		const ctx = new Context({ name: 'root' }) as any
		setDevRuntimeHandles(ctx, {
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

		expect(init.result.serverInfo.name).toBe('pluxel-hmr')

		const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
		const toolNames = (list.result.tools as any[]).map((t) => t.name)
		expect(toolNames).toContain('hmr.waitForBatch')
		expect(toolNames).toContain('hmr.waitForStable')
		expect(toolNames).toContain('hmr.lastBatch')
		expect(toolNames).toContain('hmr.executeFiles')
		expect(toolNames).toContain('logs.latest')
		expect(toolNames).toContain('logs.waitFor')
		expect(toolNames).toContain('logs.latestText')
		expect(toolNames).toContain('logs.waitForText')
		expect(toolNames).toContain('plugins.list')
		expect(toolNames).toContain('plugin.status')
		expect(toolNames).toContain('plugin.wait-for-stage')
		expect(toolNames).toContain('plugin.schema')
		expect(toolNames).toContain('plugin.config.get')
		expect(toolNames).toContain('plugin.config.validate')
		expect(toolNames).toContain('plugin.config.patch')
		expect(toolNames).toContain('plugin.config.reset')
		expect(toolNames).toContain('plugins.status.apply')
		expect(toolNames).toContain('plugins.config.set')
		expect(toolNames).toContain('runtime.ops.list')
		expect(toolNames).toContain('workspace.resolveEntry')
		expect(toolNames).toContain('workspace.listEntries')
		expect(toolNames).toContain('plugin.restart')
		expect(toolNames).toContain('plugin.enable')
		expect(toolNames).toContain('plugin.disable')
		expect(toolNames).toContain('plugin.dependencies.list')
		expect(toolNames).toContain('plugin.dependencies.inspect')
		expect(toolNames).toContain('plugin.base-provider.inspect')
		expect(toolNames).toContain('plugin.fork.ensure')

		const logs = await call({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'logs.latest', arguments: { limit: 1 } },
		})
		expect(logs.result.structuredContent).toHaveProperty('lines')
		expect(logs.result.structuredContent).toHaveProperty('meta')

		const batch = await call({
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: { name: 'hmr.waitForBatch', arguments: { timeoutMs: 100 } },
		})
		expect(batch.result.structuredContent.epoch).toBe(1)

		const stable = await call({
			jsonrpc: '2.0',
			id: 8,
			method: 'tools/call',
			params: { name: 'hmr.waitForStable', arguments: { timeoutMs: 100, quietMs: 1 } },
		})
		expect(stable.result.structuredContent.epoch).toBe(2)

		const waitFor = await call({
			jsonrpc: '2.0',
			id: 5,
			method: 'tools/call',
			params: { name: 'logs.waitFor', arguments: { timeoutMs: 1, limit: 10 } },
		})
		expect(waitFor.result.structuredContent).toHaveProperty('lines')
		expect(waitFor.result.structuredContent).toHaveProperty('meta')

		const waitForText = await call({
			jsonrpc: '2.0',
			id: 6,
			method: 'tools/call',
			params: { name: 'logs.waitForText', arguments: { timeoutMs: 1, limit: 10 } },
		})
		expect(waitForText.result.structuredContent).toHaveProperty('text')

		// Optional: lastBatch should be nullable-safe.
		const lastBatch = await call({
			jsonrpc: '2.0',
			id: 7,
			method: 'tools/call',
			params: { name: 'hmr.lastBatch', arguments: {} },
		})
		expect(lastBatch.result.structuredContent).toHaveProperty('batch')
	})

	it('refreshes MCP tool projection when ops registry changes', async () => {
		const ctx = new Context({ name: 'root' }) as any
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

		await call({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion,
				clientInfo: { name: 'pluxel-test', version: '0' },
				capabilities: {},
			},
		})

		const before = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
		expect((before.result.tools as Array<{ name: string }>).some((tool) => tool.name === 'demo.echo')).toBe(false)

		ctx.ext.ops.register(
			defineOp({
				id: 'demo.echo',
				doc: {
					title: 'Demo Echo',
					description: 'Echo a demo value.',
				},
				input: typebox.obj({
					value: typebox.Type.String({ description: 'Value to echo back.' }),
				}),
				output: typebox.obj({
					value: typebox.Type.String(),
				}),
				tool: {
					name: 'demo.echo',
				},
				async execute(input) {
					return input
				},
			}),
		)

		const after = await call({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
		expect((after.result.tools as Array<{ name: string }>).some((tool) => tool.name === 'demo.echo')).toBe(true)

		const echo = await call({
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: { name: 'demo.echo', arguments: { value: 'ok' } },
		})
		expect(echo.result.structuredContent).toEqual({ value: 'ok' })
	})
})

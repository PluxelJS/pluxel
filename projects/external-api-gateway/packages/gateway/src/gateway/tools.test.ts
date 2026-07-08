import { describe, expect, it } from 'vitest'
import type { GatewayBillingContext } from '@repo/external-api-gateway-shared/gateway'
import { callExternalGatewayTool, type ExternalGatewayToolHost } from './tool-dispatcher.ts'
import { externalGatewayPiTools, PiExtension } from './pi-extension.ts'
import {
	EXTERNAL_GATEWAY_TOOL_NAMES,
	listExternalGatewayToolSpecs,
	requireExternalGatewayToolName,
} from './tools.ts'

describe('external gateway tool contract', () => {
	it('keeps tool names unique and all specs addressable by literal name', () => {
		const specs = listExternalGatewayToolSpecs()
		expect(new Set(EXTERNAL_GATEWAY_TOOL_NAMES).size).toBe(EXTERNAL_GATEWAY_TOOL_NAMES.length)
		expect(specs.map((spec) => spec.name).sort()).toEqual([...EXTERNAL_GATEWAY_TOOL_NAMES].sort())
		for (const spec of specs) {
			expect(spec.inputSchema.type).toBe('object')
			expect(spec.description.length).toBeGreaterThan(20)
		}
	})

	it('filters specs by provider and name without exposing the backing array', () => {
		const zhipuSpecs = listExternalGatewayToolSpecs({ provider: 'zhipu' })
		expect(zhipuSpecs.every((spec) => spec.provider === 'zhipu')).toBe(true)

		const selected = listExternalGatewayToolSpecs({ names: ['yiqicha.enterprise_profile'] })
		expect(selected.map((spec) => spec.name)).toEqual(['yiqicha.enterprise_profile'])

		selected[0].inputSchema.required = []
		expect(listExternalGatewayToolSpecs({ names: ['yiqicha.enterprise_profile'] })[0].inputSchema.required).toEqual([
			'keyword',
		])
		selected[0].inputSchema.properties = {}
		expect(
			Object.keys(listExternalGatewayToolSpecs({ names: ['yiqicha.enterprise_profile'] })[0].inputSchema.properties ?? {}),
		).toContain('keyword')
	})

	it('rejects unknown tool names before dispatch', () => {
		expect(() => requireExternalGatewayToolName('zhipu.search')).toThrow('Unknown gateway tool')
	})

	it('exports PI tool definitions from the reusable extension entry', () => {
		expect(externalGatewayPiTools.map((tool) => tool.function.name).sort()).toEqual(
			[...EXTERNAL_GATEWAY_TOOL_NAMES].sort(),
		)
		expect(() => new PiExtension({ token: '' })).toThrow('PiExtension token is required')
	})

	it('adapts PI/OpenAI tool calls to gateway RPC calls', async () => {
		const calls: unknown[] = []
		const pi = new PiExtension({
			token: 'token-123',
			rpcUrl: 'http://gateway.test/rpc',
			billing: 'pi-user',
			transport: {
				authenticate(apiToken) {
					calls.push({ operation: 'authenticate', apiToken })
					return {
						whoami() {
							calls.push({ operation: 'whoami' })
							return { tokenId: 'pi-token', name: 'PI token' }
						},
						async toolSpecs(input) {
							calls.push({ operation: 'toolSpecs', input })
							return listExternalGatewayToolSpecs(input)
						},
						async callTool(input) {
							calls.push({ operation: 'callTool', input })
							return { ok: true }
						},
					}
				},
			},
		})
		expect(await pi.getTools({ provider: 'zhipu' })).toHaveLength(6)
		await expect(pi.test({ provider: 'yiqicha' })).resolves.toMatchObject({
			ok: true,
			rpcUrl: 'http://gateway.test/rpc',
			authenticated: true,
			localToolCount: EXTERNAL_GATEWAY_TOOL_NAMES.length,
			remoteToolCount: 6,
			tokenId: 'pi-token',
			tokenName: 'PI token',
		})
		await expect(
			pi.handleToolCall({
				id: 'call-1',
				function: {
					name: 'zhipu.web_search',
					arguments: '{"query":"GLM"}',
				},
			}),
		).resolves.toEqual({
			toolCallId: 'call-1',
			name: 'zhipu.web_search',
			result: { ok: true },
		})
		expect(calls).toEqual([
			{ operation: 'authenticate', apiToken: 'token-123' },
			{ operation: 'toolSpecs', input: { provider: 'zhipu' } },
			{ operation: 'whoami' },
			{ operation: 'toolSpecs', input: { provider: 'yiqicha' } },
			{
				operation: 'callTool',
				input: {
					name: 'zhipu.web_search',
					args: { query: 'GLM' },
					billing: 'pi-user',
				},
			},
		])
	})

	it('reports RPC health failures without throwing', async () => {
		const pi = new PiExtension({
			token: 'token-123',
			rpcUrl: 'http://bad-gateway.test/rpc',
			transport: {
				authenticate() {
					return {
						whoami() {
							throw new Error('invalid token')
						},
						async toolSpecs() {
							throw new Error('invalid token')
						},
						async callTool() {
							throw new Error('not used')
						},
					}
				},
			},
		})

		await expect(pi.test()).resolves.toEqual({
			ok: false,
			rpcUrl: 'http://bad-gateway.test/rpc',
			authenticated: false,
			localToolCount: EXTERNAL_GATEWAY_TOOL_NAMES.length,
			error: 'invalid token',
		})
	})
})

describe('external gateway tool dispatcher', () => {
	it('maps zhipu.web_search from agent-friendly args to provider args', async () => {
		const host = createHost()
		const billing = billingContext()

		const result = await callExternalGatewayTool(host, billing, 'zhipu.web_search', {
			query: '  GLM OpenAPI  ',
			count: 5,
			contentSize: 'high',
		})

		expect(result).toEqual({ ok: true, provider: 'zhipu', operation: 'web_search' })
		expect(host.calls).toEqual([
			{
				provider: 'zhipu',
				operation: 'web_search',
				billing,
				input: {
					search_query: 'GLM OpenAPI',
					search_engine: 'search-std',
					search_intent: true,
					count: 5,
					search_domain_filter: undefined,
					search_recency_filter: undefined,
					content_size: 'high',
				},
			},
		])
	})

	it('normalizes yiqicha.call_api params for provider-safe primitive values', async () => {
		const host = createHost()
		const billing = billingContext()

		await callExternalGatewayTool(host, billing, 'yiqicha.call_api', {
			api: 'getBasicInfo',
			params: {
				keyword: '智谱',
				flags: ['a', 1, true],
				nested: { province: '北京' },
				empty: null,
			},
		})

		expect(host.calls).toEqual([
			{
				provider: 'yiqicha',
				operation: 'getBasicInfo',
				billing,
				params: {
					keyword: '智谱',
					flags: ['a', 1, true],
					nested: '{"province":"北京"}',
				},
			},
		])
	})

	it('passes yiqicha noCache through as an explicit refresh option', async () => {
		const host = createHost()
		const billing = billingContext()

		await callExternalGatewayTool(host, billing, 'yiqicha.call_api', {
			api: 'getBasicInfo',
			params: { keyword: '智谱' },
			noCache: true,
		})

		expect(host.calls).toEqual([
			{
				provider: 'yiqicha',
				operation: 'getBasicInfo',
				billing,
				params: { keyword: '智谱' },
				options: { noCache: true },
			},
		])
	})

	it('composes enterprise profile tools into a small set of semantic provider calls', async () => {
		const host = createHost()
		const billing = billingContext()

		const result = await callExternalGatewayTool(host, billing, 'yiqicha.enterprise_profile', {
			keyword: '智谱',
			include: ['basicInfo', 'contacts'],
			pageSize: 100,
		})

		expect(result).toEqual({
			basicInfo: { ok: true, api: 'getBasicInfo' },
			contacts: { ok: true, api: 'contractDetailEnterpriseList' },
		})
		expect(host.calls).toEqual([
			{
				provider: 'yiqicha',
				operation: 'getBasicInfo',
				billing,
				params: { keyword: '智谱' },
			},
			{
				provider: 'yiqicha',
				operation: 'contractDetailEnterpriseList',
				billing,
				params: { keyword: '智谱', page: 1, pageSize: 20 },
			},
		])
	})
})

function billingContext(): GatewayBillingContext {
	return { userId: 'user-123', tenantId: 'tenant-a', traceId: 'trace-001' }
}

function createHost(): ExternalGatewayToolHost & { calls: unknown[] } {
	const calls: unknown[] = []
	return {
		calls,
		zhipuProvider: {
			async gatewayChatCompletions(billing, input) {
				calls.push({ provider: 'zhipu', operation: 'chat', billing, input })
				return { ok: true, provider: 'zhipu', operation: 'chat' }
			},
			async gatewayWebSearch(billing, input) {
				calls.push({ provider: 'zhipu', operation: 'web_search', billing, input })
				return { ok: true, provider: 'zhipu', operation: 'web_search' }
			},
			async gatewayReader(billing, input) {
				calls.push({ provider: 'zhipu', operation: 'reader', billing, input })
				return { ok: true, provider: 'zhipu', operation: 'reader' }
			},
			async gatewayRerank(billing, input) {
				calls.push({ provider: 'zhipu', operation: 'rerank', billing, input })
				return { ok: true, provider: 'zhipu', operation: 'rerank' }
			},
			async gatewayEmbeddings(billing, input) {
				calls.push({ provider: 'zhipu', operation: 'embeddings', billing, input })
				return { ok: true, provider: 'zhipu', operation: 'embeddings' }
			},
			async gatewayModerations(billing, input) {
				calls.push({ provider: 'zhipu', operation: 'moderations', billing, input })
				return { ok: true, provider: 'zhipu', operation: 'moderations' }
			},
		},
		yiqichaProvider: {
			listCatalog(filter) {
				calls.push({ provider: 'yiqicha', operation: 'find_apis', filter })
				return []
			},
			getApiDoc(api) {
				calls.push({ provider: 'yiqicha', operation: 'describe_api', api })
				return {
					id: api,
					apiName: api,
					apiCode: api,
					apiUrl: '',
					cateName: '',
					requestMethod: 'GET',
					requiredParams: [],
					requestJson: '{}',
					responseJson: '{}',
					responseDemo: '{}',
				}
			},
			async gatewayCallApi(billing, api, params, options) {
				calls.push({ provider: 'yiqicha', operation: api, billing, params, ...(options ? { options } : {}) })
				return { ok: true, api }
			},
		},
	}
}

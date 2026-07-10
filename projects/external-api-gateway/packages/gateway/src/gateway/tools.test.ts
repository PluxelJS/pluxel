import { describe, expect, it } from 'vitest'
import type { GatewayBillingContext } from '@repo/external-api-gateway-shared/gateway'
import { callExternalGatewayTool, type ExternalGatewayToolHost } from './tool-dispatcher.ts'
import {
	externalGatewayPiTools,
	externalGatewayToolNameToPiName,
	PiExtension,
	yiqichaBundleCalls,
} from './pi-extension.ts'
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

		const selected = listExternalGatewayToolSpecs({ names: ['yiqicha.recommend_bundle'] })
		expect(selected.map((spec) => spec.name)).toEqual(['yiqicha.recommend_bundle'])

		selected[0].inputSchema.required = []
		expect(
			listExternalGatewayToolSpecs({ names: ['yiqicha.recommend_bundle'] })[0].inputSchema.required,
		).toBeUndefined()
		selected[0].inputSchema.properties = {}
		expect(
			Object.keys(
				listExternalGatewayToolSpecs({ names: ['yiqicha.recommend_bundle'] })[0].inputSchema
					.properties ?? {},
			),
		).toContain('bundle')
	})

	it('publishes TypeBox-derived JSON schemas with useful constraints', () => {
		const webSearch = listExternalGatewayToolSpecs({ names: ['zhipu.web_search'] })[0]
		const webSearchProperties = webSearch.inputSchema.properties as Record<
			string,
			Record<string, unknown>
		>
		expect(webSearchProperties.query.minLength).toBe(1)
		expect(webSearchProperties.count.maximum).toBe(50)
		expect(webSearchProperties.recency.enum).toEqual([
			'oneDay',
			'oneWeek',
			'oneMonth',
			'oneYear',
			'noLimit',
		])

		const embeddings = listExternalGatewayToolSpecs({ names: ['zhipu.embeddings'] })[0]
		const embeddingsProperties = embeddings.inputSchema.properties as Record<
			string,
			Record<string, unknown>
		>
		expect(embeddingsProperties.input.anyOf).toHaveLength(2)

		const recommend = listExternalGatewayToolSpecs({ names: ['yiqicha.recommend_bundle'] })[0]
		expect(recommend.metadata).toMatchObject({ billable: false, latency: 'local' })
		expect(recommend.examples?.[0]?.args).toMatchObject({ bundle: 'profile' })
	})

	it('rejects unknown tool names before dispatch', () => {
		expect(() => requireExternalGatewayToolName('zhipu.search')).toThrow('Unknown gateway tool')
	})

	it('exports PI tool definitions from the reusable extension entry', () => {
		const piNames = externalGatewayPiTools.map((tool) => tool.function.name)
		expect(piNames.sort()).toEqual(
			EXTERNAL_GATEWAY_TOOL_NAMES.map(externalGatewayToolNameToPiName).sort(),
		)
		expect(externalGatewayPiTools.every((tool) => /^[A-Za-z0-9_-]{1,64}$/.test(tool.function.name))).toBe(
			true,
		)
		expect(new Set(piNames).size).toBe(EXTERNAL_GATEWAY_TOOL_NAMES.length)
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
						async callTools() {
							throw new Error('not used')
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
			remoteToolCount: 4,
			tokenId: 'pi-token',
			tokenName: 'PI token',
		})
		await expect(
			pi.handleToolCall({
				id: 'call-1',
				function: {
					name: 'zhipu_web_search',
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

	it('exposes typed provider wrappers for coding callers', async () => {
		const calls: unknown[] = []
		const pi = new PiExtension({
			token: 'token-123',
			rpcUrl: 'http://gateway.test/rpc',
			billing: 'pi-user',
			transport: {
				authenticate() {
					return {
						whoami() {
							return { tokenId: 'pi-token', name: 'PI token' }
						},
						async toolSpecs(input) {
							return listExternalGatewayToolSpecs(input)
						},
						async callTool(input) {
							calls.push(input)
							return { ok: true }
						},
						async callTools() {
							throw new Error('not used')
						},
					}
				},
			},
		})

		await expect(pi.zhipu.webSearch({ query: 'GLM', count: 3 })).resolves.toEqual({ ok: true })
		await expect(
			pi.yiqicha.recommendBundle({ bundle: 'profile', keyword: '智谱' }),
		).resolves.toEqual({
			ok: true,
		})

		expect(calls).toEqual([
			{
				name: 'zhipu.web_search',
				args: { query: 'GLM', count: 3 },
				billing: 'pi-user',
			},
			{
				name: 'yiqicha.recommend_bundle',
				args: { bundle: 'profile', keyword: '智谱' },
				billing: 'pi-user',
			},
		])
	})

	it('accepts OpenAI-safe PI tool names in programming calls while dispatching canonical names', async () => {
		const calls: unknown[] = []
		const pi = new PiExtension({
			token: 'token-123',
			rpcUrl: 'http://gateway.test/rpc',
			billing: 'pi-user',
			transport: {
				authenticate() {
					return {
						whoami() {
							return { tokenId: 'pi-token', name: 'PI token' }
						},
						async toolSpecs(input) {
							return listExternalGatewayToolSpecs(input)
						},
						async callTool(input) {
							calls.push(input)
							return { ok: true }
						},
						async callTools(input) {
							calls.push(input)
							return { results: [] }
						},
					}
				},
			},
		})

		await pi.callTool('zhipu_web_search', { query: 'GLM' })
		await pi.callTools([{ name: 'yiqicha_call_api', args: { api: 'getBasicInfo', params: {} } }])

		expect(calls).toEqual([
			{
				name: 'zhipu.web_search',
				args: { query: 'GLM' },
				billing: 'pi-user',
			},
			{
				calls: [
					{
						name: 'yiqicha.call_api',
						args: { api: 'getBasicInfo', params: {} },
						billing: 'pi-user',
					},
				],
			},
		])
	})

	it('batches explicit tool calls for coding callers', async () => {
		const calls: unknown[] = []
		const pi = new PiExtension({
			token: 'token-123',
			rpcUrl: 'http://gateway.test/rpc',
			billing: 'pi-user',
			transport: {
				authenticate() {
					return {
						whoami() {
							return { tokenId: 'pi-token', name: 'PI token' }
						},
						async toolSpecs(input) {
							return listExternalGatewayToolSpecs(input)
						},
						async callTool() {
							throw new Error('not used')
						},
						async callTools(input) {
							calls.push(input)
							return {
								results: input.calls.map((call, index) => ({
									index,
									name: call.name,
									ok: true,
									result: { ok: true },
								})),
							}
						},
					}
				},
			},
		})

		await expect(
			pi.callTools([
				{ name: 'yiqicha.call_api', args: { api: 'getBasicInfo', params: { keyword: '智谱' } } },
				{
					name: 'yiqicha.call_api',
					args: { api: 'getEnterprisePartners', params: { keyword: '智谱' } },
				},
			]),
		).resolves.toMatchObject({
			results: [
				{ index: 0, name: 'yiqicha.call_api', ok: true },
				{ index: 1, name: 'yiqicha.call_api', ok: true },
			],
		})
		expect(calls).toEqual([
			{
				calls: [
					{
						name: 'yiqicha.call_api',
						args: { api: 'getBasicInfo', params: { keyword: '智谱' } },
						billing: 'pi-user',
					},
					{
						name: 'yiqicha.call_api',
						args: { api: 'getEnterprisePartners', params: { keyword: '智谱' } },
						billing: 'pi-user',
					},
				],
			},
		])
	})

	it('turns YiQiCha recommendations into explicit batch calls', () => {
		const calls = yiqichaBundleCalls(
			{
				provider: 'yiqicha',
				bundle: 'profile',
				description: 'test',
				estimatedCalls: 2,
				note: 'test',
				calls: [
					{
						id: 'basicInfo',
						api: 'getBasicInfo',
						label: 'Basic',
						reason: 'Core profile',
						params: { keyword: '智谱' },
					},
					{
						id: 'shareholders',
						api: 'getEnterprisePartners',
						label: 'Shareholders',
						reason: 'Ownership',
						params: { keyword: '智谱', page: 1, pageSize: 50 },
					},
				],
			},
			{ only: ['shareholders'], billing: 'pi-user', noCache: true },
		)

		expect(calls).toEqual([
			{
				name: 'yiqicha.call_api',
				args: {
					api: 'getEnterprisePartners',
					params: { keyword: '智谱', page: 1, pageSize: 50 },
					noCache: true,
				},
				billing: 'pi-user',
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
						async callTools() {
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

	it('validates tool args against the published schema before dispatch', async () => {
		const host = createHost()

		await expect(
			callExternalGatewayTool(host, billingContext(), 'zhipu.web_search', {
				query: 'GLM',
				unexpected: true,
			}),
		).rejects.toThrow('Invalid args for zhipu.web_search')
		expect(host.calls).toEqual([])
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

	it('recommends enterprise bundles without making paid provider calls', async () => {
		const host = createHost()
		const billing = billingContext()

		const result = await callExternalGatewayTool(host, billing, 'yiqicha.recommend_bundle', {
			bundle: 'profile',
			keyword: '智谱',
			include: ['basicInfo', 'contacts'],
			pageSize: 100,
		})

		expect(result).toMatchObject({
			provider: 'yiqicha',
			bundle: 'profile',
			estimatedCalls: 2,
			calls: [
				{ id: 'basicInfo', api: 'getBasicInfo', params: { keyword: '智谱' } },
				{
					id: 'contacts',
					api: 'contractDetailEnterpriseList',
					params: { keyword: '智谱', page: 1, pageSize: 50 },
				},
			],
		})
		expect(host.calls).toEqual([])
	})

	it('recommends risk bundles with pageSize 50 defaults', async () => {
		const host = createHost()
		const billing = billingContext()

		const result = await callExternalGatewayTool(host, billing, 'yiqicha.recommend_bundle', {
			bundle: 'risk',
			keyword: '智谱',
			include: ['abnormalOperations'],
		})

		expect(result).toMatchObject({
			estimatedCalls: 1,
			calls: [
				{
					id: 'abnormalOperations',
					api: 'entAbnormalList1031',
					params: { keyword: '智谱', page: 1, pageSize: 50 },
				},
			],
		})
		expect(host.calls).toEqual([])
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
				calls.push({
					provider: 'yiqicha',
					operation: api,
					billing,
					params,
					...(options ? { options } : {}),
				})
				return { ok: true, api }
			},
		},
	}
}

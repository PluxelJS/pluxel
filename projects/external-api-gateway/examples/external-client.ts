import { newHttpBatchRpcSession, type RpcPromise } from 'capnweb'
import type { AuthedApi, ExternalGatewayRpc } from '@repo/external-api-gateway-gateway'

const rpc = newHttpBatchRpcSession<ExternalGatewayRpc>(
	'http://127.0.0.1:3313/__pluxel/plugins/ExternalGatewayPlugin/gateway/rpc',
)

const authedApi: RpcPromise<AuthedApi> = rpc.authenticate('dev-zhipu-token-change-me')

const whoamiPromise = authedApi.whoami()
const ocrPromise = authedApi
	.bill({ userId: 'user-123', tenantId: 'tenant-a', traceId: 'trace-001' })
	.zhipu()
	.ocr()
	.layoutParsing({
		model: 'glm-ocr',
		file: 'https://example.com/demo.pdf',
	})
const parserSyncPromise = authedApi
	.bill({ userId: 'user-123', tenantId: 'tenant-a', traceId: 'trace-parser-sync-001' })
	.zhipu()
	.tools()
	.fileParser()
	.sync({
		fileName: 'demo.txt',
		contentType: 'text/plain',
		bytes: new TextEncoder().encode('用来演示文件解析 typed wrapper 的文本。'),
		file_type: 'TXT',
		tool_type: 'prime-sync',
	})
const searchPromise = authedApi
	.bill({ userId: 'user-123', tenantId: 'tenant-a', traceId: 'trace-search-001' })
	.zhipu()
	.search()
	.webSearch({
		search_query: '智谱 GLM OpenAPI web_search',
		search_engine: 'search_std',
		search_intent: false,
		count: 5,
		search_recency_filter: 'noLimit',
		content_size: 'medium',
	})
const embeddingsPromise = authedApi
	.bill({ userId: 'user-123', tenantId: 'tenant-a', traceId: 'trace-embeddings-001' })
	.zhipu()
	.embeddings()
	.create({
		model: 'embedding-3',
		input: '智谱 OpenAPI provider through Pluxel CapnWeb',
		dimensions: 1024,
	})
const chatPromise = authedApi
	.bill({ userId: 'user-123', tenantId: 'tenant-a', traceId: 'trace-chat-001' })
	.zhipu()
	.models()
	.chatCompletions({
		model: 'glm-4.5-flash',
		messages: [{ role: 'user', content: '用一句话解释 Pluxel gateway 的作用' }],
	})
const yiqichaCatalogPromise = authedApi
	.bill({ userId: 'user-123', tenantId: 'tenant-a', traceId: 'trace-yiqicha-catalog' })
	.yiqicha()
	.findApis({ query: '工商照面 股东 对外投资', limit: 10 })
const yiqichaSchemaPromise = authedApi
	.bill({ userId: 'user-123', tenantId: 'tenant-a', traceId: 'trace-yiqicha-basic' })
	.yiqicha()
	.getApiSchema({ api: 'getBasicInfo' })
const yiqichaProfilePromise = authedApi
	.bill({ userId: 'user-123', tenantId: 'tenant-a', traceId: 'trace-yiqicha-profile' })
	.yiqicha()
	.getEnterpriseProfile({
		keyword: '亿企查科技有限公司',
		include: ['basicInfo', 'shareholders', 'investments'],
		pageSize: 5,
	})
const yiqichaRiskPromise = authedApi
	.bill({ userId: 'user-123', tenantId: 'tenant-a', traceId: 'trace-yiqicha-risk' })
	.yiqicha()
	.getEnterpriseRiskOverview({ keyword: '亿企查科技有限公司', pageSize: 5 })
const yiqichaAnyApiPromise = authedApi
	.bill({ userId: 'user-123', tenantId: 'tenant-a', traceId: 'trace-yiqicha-any' })
	.yiqicha()
	.callApi({ api: 'matchSearch', params: { keyword: '亿企查科技有限公司', pageSize: 5 } })

const [
	whoami,
	ocr,
	parserSync,
	search,
	embeddings,
	chat,
	yiqichaCatalog,
	yiqichaSchema,
	yiqichaProfile,
	yiqichaRisk,
	yiqichaAnyApi,
] = await Promise.allSettled([
	whoamiPromise,
	ocrPromise,
	parserSyncPromise,
	searchPromise,
	embeddingsPromise,
	chatPromise,
	yiqichaCatalogPromise,
	yiqichaSchemaPromise,
	yiqichaProfilePromise,
	yiqichaRiskPromise,
	yiqichaAnyApiPromise,
])
console.log({
	whoami,
	ocr,
	parserSync,
	search,
	embeddings,
	chat,
	yiqichaCatalog,
	yiqichaSchema,
	yiqichaProfile,
	yiqichaRisk,
	yiqichaAnyApi,
})

rpc[Symbol.dispose]?.()

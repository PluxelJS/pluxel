import { newHttpBatchRpcSession, type RpcPromise } from 'capnweb'
import type { AuthedApi, ExternalGatewayRpc } from '../src/gateway/plugin.ts'

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
		prompt: '请提取标题、日期和总金额，返回 JSON。',
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

const [whoami, ocr, search, embeddings, chat] = await Promise.allSettled([
	whoamiPromise,
	ocrPromise,
	searchPromise,
	embeddingsPromise,
	chatPromise,
])
console.log({ whoami, ocr, search, embeddings, chat })

rpc[Symbol.dispose]?.()

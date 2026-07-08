# External API Gateway

独立的 `runtime-static` 项目，用 Pluxel 插件系统接入外部 API。

当前插件：

- `ExternalGatewayPlugin`：外部 Cap'n Web RPC 入口，负责 `apiToken -> AuthedApi`、token 吊销和 capability 编排。
- `UsageBillingPlugin`：上游用量/计费插件，按 `userId + provider + operation + model` 汇总调用、延迟、输入输出体积、单位用量和成本。
- `ZhipuProviderPlugin`：智谱 OpenAPI provider，依赖 `UsageBillingPlugin`，保存 API Key，并通过 OpenAPI-shaped capability 暴露 OCR、搜索、模型、embedding、rerank 等接口。

## Commands

```bash
pnpm --filter @pluxel/project-external-api-gateway dev
pnpm --filter @pluxel/project-external-api-gateway static
pnpm --filter @pluxel/project-external-api-gateway verify
```

默认端口：`3313`。

## External Cap'n Web RPC

外部入口：

```text
http://127.0.0.1:3313/__pluxel/plugins/ExternalGatewayPlugin/gateway/rpc
```

默认开发 token：

```text
dev-zhipu-token-change-me
```

调用方使用 pipeline capability，不要先 await 中间对象：

```ts
import { newHttpBatchRpcSession, type RpcPromise } from 'capnweb'
import type { AuthedApi, ExternalGatewayRpc } from './src/gateway/plugin'

const api = newHttpBatchRpcSession<ExternalGatewayRpc>(
	'http://127.0.0.1:3313/__pluxel/plugins/ExternalGatewayPlugin/gateway/rpc',
)

const authedApi: RpcPromise<AuthedApi> = api.authenticate(apiToken)

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
	})
const chatPromise = authedApi
	.bill({ userId: 'user-123', tenantId: 'tenant-a', traceId: 'trace-chat-001' })
	.zhipu()
	.models()
	.chatCompletions({
		model: 'glm-4.5-flash',
		messages: [{ role: 'user', content: 'hello' }],
	})

const [whoami, ocr, search, chat] = await Promise.allSettled([
	whoamiPromise,
	ocrPromise,
	searchPromise,
	chatPromise,
])
```

`bill(...)` 是强制的计费上下文边界。后面的 provider capability 会自动把 `userId / tenantId / traceId` 写入 `UsageBillingPlugin`。

`ExternalGatewayPlugin` 的 token 只做认证和吊销：有效 token 可以访问 gateway 暴露的全部 provider capability；吊销后不可再认证。调用归属、成本和审计由 `bill(...)` 里的 `userId / tenantId / traceId` 以及 `UsageBillingPlugin` 记录。本地开发会自动创建默认 token；生产环境只有显式设置 `PLUXEL_EXTERNAL_GATEWAY_DEV_TOKEN` 时才会创建开发 token。

`projects/zhipu-glm-openapi-client.zip` 中的 generated client 目前还是 placeholder；真正 typed helper 需要跑 zip 内 `refresh` 生成。当前项目先通过 `zhipu().openapi().request({ method, path, body, operation })` 覆盖任意 Zhipu OpenAPI 路径，并提供按官方 OpenAPI 字段建模的常用 wrapper。`path` 可以传 base-relative 路径如 `/web_search`，也可以传官方 spec 路径如 `/paas/v4/web_search`。

Gateway 也暴露 provider descriptor 和轻量 generic call 入口：

```ts
authedApi
	.bill({ userId: 'user-123' })
	.provider('zhipu')
	.call({
		operation: 'web_search',
		body: {
			search_query: '智谱 GLM OpenAPI',
			search_engine: 'search_std',
			search_intent: false,
		},
	})
```

常用路径仍优先使用 typed wrapper，generic provider call 用于新增 provider 过渡期、临时 OpenAPI 路径或外部系统按 descriptor 调用。

- `layoutParsing({ model: "glm-ocr", file, prompt?, return_crop_images?, need_layout_visualization?, start_page_id?, end_page_id?, request_id?, user_id?, ... })`
- `filesOcr({ fileName, contentType?, bytes, fields: { tool_type: "hand_write", language_type?, probability? } })`
- `webSearch({ search_query, search_engine, search_intent, count?, search_domain_filter?, search_recency_filter?, content_size?, request_id?, user_id? })`
- `models().chatCompletions({ model, messages, stream?, thinking?, reasoning_effort?, tools?, response_format?, request_id?, user_id?, ... })`
- `embeddings().create({ model, input, dimensions? })`
- `rerank().create({ model, query, documents, top_n?, return_documents?, return_raw_scores?, request_id?, user_id? })`
- `tools().reader({ url, timeout?, no_cache?, return_format?, retain_images?, ... })`
- `moderations().create({ model, input })`

通用 OpenAPI 入口用于先接入还没写 wrapper 的路径：

```ts
authedApi
	.bill({ userId: 'user-123' })
	.zhipu()
	.openapi()
		.request({
			method: 'POST',
			path: '/paas/v4/web_search',
			operation: 'web_search',
			body: {
			search_query: '智谱 GLM OpenAPI',
			search_engine: 'search_std',
			search_intent: false,
		},
	})
```

## API Catalog Priority

从智谱 OpenAPI 看，当前最值得优先封装的 API：

- OCR：`/paas/v4/layout_parsing`、`/paas/v4/files/ocr`，适合文档解析、图片/PDF 识别。
- 搜索/读取：`/paas/v4/web_search`、`/paas/v4/reader`，适合联网问答、网页抓取转 markdown。
- 模型：`/paas/v4/chat/completions`，适合统一从 gateway 计费的 GLM 调用。
- RAG 基础能力：`/paas/v4/embeddings`、`/paas/v4/rerank`，适合知识库检索链路。
- 安全：`/paas/v4/moderations`，适合把外部输入审核也纳入同一套用量审计。
- 批处理/文件：files、batches 系列后续可补，它们更适合异步任务面板和任务状态轮询。

## Adapter Contract

Provider 插件负责外部 API 适配、上游错误解析、请求预览脱敏和调用后产生 usage event。当前 `UsageBillingPlugin` 是唯一 usage recorder；未来如果要接多个计费 sink 或 quota/policy 插件，应优先保持 `UsageEvent` 稳定，而不是让 provider 直接依赖多个计费插件。

```ts
class SomeProviderPlugin extends BasePlugin {
	constructor(private readonly billing: UsageBillingPlugin) {
		super()
	}
}

setParamToken(SomeProviderPlugin, 0, UsageBillingPlugin)
```

每次外部 API 调用后记录中性 usage event：

```ts
this.billing.recordUsage({
	userId,
	provider: 'some-provider',
	pluginId: this.ctx.pluginInfo.id,
	operation: 'chat.completions',
	status: '200',
	ok: true,
	latencyMs,
	inputBytes,
	units: usage.total_tokens,
	unitName: 'token',
})
```

`src/usage/contracts.ts` 中的 `UsageEvent` 是 provider 和 billing 的边界。新增计费插件时建议先作为 recorder/sink 消费同一个事件结构，再按需要增加 quota/policy 的调用前检查。

Provider 应提供 `ProviderDescriptor`，描述 `id / label / operations`。Gateway 通过 descriptor 暴露 `providers()` 和 `provider(id).call(...)`，同时保留 typed API，避免为了统一而牺牲常用路径的类型体验。

`UsageBillingPlugin` 的价格表使用 `provider:operation[:model]` 作为 key。provider 插件可以记录 `request`、`token`、`page`、`image` 等不同 unit，具体单价通过 `upsertRate` 配置；未配置时成本按 `0` 估算，但用量仍会完整保留。

Billing UI 已暴露费率编辑入口，可直接配置 `provider / operation / model / unitName / unitCostCny`。新增调用会按当前费率估算成本；已有明细不会被重算。

## Persistence

插件运行数据使用项目内 SQLite 文件：

```text
.pluxel/static/plugin-data/external-api-gateway.sqlite
```

当前持久化内容：

- gateway tokens：保存 token hash、启用/吊销状态和最近使用时间；UI 只展示预览。
- billing usage records / rates：账单明细和价格表会跨重启保留；UI 明细只加载最近 500 条，汇总按 SQLite 全量记录重建。
- Zhipu test history：插件 UI 的 OCR/API 测试历史跨重启保留。OCR 请求预览会脱敏 data URL/base64 文件内容，只保留来源和体积摘要。

当前组织方式：

- gateway 插件只负责外部 token 认证/吊销和 capability 分发。
- provider 插件负责 API key、OpenAPI path/body、上游响应解析和调用后落账。
- billing 插件作为所有 provider 的上游依赖，统一记录 `userId / tenantId / traceId / provider / operation / model / cost`。
- gateway 当前使用静态 provider descriptors。provider 数量继续增多时，可以把构造函数依赖迁移为 provider registry；在 runtime-static 阶段显式依赖仍更直接，也更符合当前 Pluxel 示例形态。

## Zhipu Routes

- `GET /__pluxel/plugins/ZhipuProviderPlugin/zhipu/status`
- `POST /__pluxel/plugins/ZhipuProviderPlugin/zhipu/files-ocr`
- `POST /__pluxel/plugins/ZhipuProviderPlugin/zhipu/layout-parsing`

`userId` 可以通过 `x-pluxel-user-id` / `x-user-id` header、URL query，或请求体字段传入。

Zhipu client 默认上游请求超时为 120 秒。插件 UI 的 GLM OCR 面板支持直接上传本地图片/PDF，也支持手工填写 OpenAPI `file` 字段和 `prompt`，适合测试 `/layout_parsing` 的 prompt 效果。

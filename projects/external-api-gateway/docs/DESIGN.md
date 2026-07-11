# External API Gateway Design

本文档面向维护者，说明 gateway 的协议边界、Cap'n Web 使用约定、tool surface 和 provider/billing 分层。

## Goals

- 给外部程序提供稳定、可类型化、适合 agent 的工具接口。
- 不把上游 OpenAPI path 原样暴露成长期外部协议。
- 保持计费归属显式：每次调用必须带 `billing`。
- 让常见多调用流程可以通过 Cap'n Web HTTP batch 合并成一次网络往返。
- Provider 可以保留 raw route 供 UI 和本地调试，但外部能力必须先进入稳定 gateway tool schema。

## Plugin Boundaries

- `ExternalGatewayPlugin`：外部 token 认证/吊销、Cap'n Web RPC、HTTP fallback、tool specs 和 tool dispatch。
- `ZhipuProviderPlugin`：智谱 API key、OpenAPI path/body、上游响应解析、调用历史和 usage event。
- `YiqichaProviderPlugin`：亿企查凭据、API catalog、request/response 适配和 usage event。
- `UsageBillingPlugin`：统一记录 `userId / tenantId / traceId / provider / operation / model / units / cost`。

Provider 插件依赖 shared usage recorder，不直接依赖 billing 包。新增计费 sink 或 quota/policy 插件时，应优先消费同一个 `UsageEvent` 边界。

## Cap'n Web Shape

RPC 入口只暴露一个 public capability：

```ts
type ExternalGatewayRpcTransport = {
	authenticate(apiToken: string): Awaitable<ExternalGatewayAuthedRpc>
}
```

认证后返回 `AuthedApi` capability：

```ts
type ExternalGatewayAuthedRpc = {
	whoami(): Awaitable<GatewayAuthContext>
	toolSpecs(input?: ExternalGatewayToolListInput): Awaitable<ExternalGatewayToolSpec[]>
	callTool(input: ExternalGatewayToolCallInput): Awaitable<unknown>
	callTools(input: ExternalGatewayToolBatchCallInput): Awaitable<ExternalGatewayToolBatchCallResult>
}
```

这个形状符合 object-capability 设计：未认证调用方只能拿到 `authenticate`，认证后才得到可调用工具的 `AuthedApi`。不要把 token 作为每个 RPC 方法的参数重复传递。

HTTP batch 约定：

- 默认 `PiExtension.callTool(...)` / `callTools(...)` / `test(...)` 每次创建 fresh HTTP batch session，完成后释放。
- `PiExtension.batch()` 是高级 API，用于调用方显式 promise pipelining；调用方必须在同一轮里 `Promise.all` 等待需要的结果，不能复用 batch stub。
- `callTools(...)` 是服务端并行执行多个 tool 的便利 API；它不是 Cap'n Web promise pipelining 的替代品。
- 不缓存默认 HTTP batch stub，避免 batch 完成后复用 closed session。
- 如果未来需要长期双向交互，再单独引入 WebSocket transport，不要把 HTTP batch 当长连接使用。

## Tool Naming

内部 gateway canonical name 使用 `provider.action`：

- `zhipu.web_search`
- `zhipu.chat`
- `yiqicha.call_api`
- `yiqicha.recommend_bundle`

导给 OpenAI/PI function tools 时转成 `provider_action`：

- `zhipu_web_search`
- `zhipu_chat`
- `yiqicha_call_api`
- `yiqicha_recommend_bundle`

原因：

- 内部名更适合 gateway catalog、provider 分组和编程调用。
- OpenAI-style function name 应使用字母、数字、下划线或短横线，避免带点号。
- `PiExtension.handleToolCall(...)` 负责把 agent tool name 映射回内部 canonical name。

新增 tool 时必须：

1. 在 `tools.ts` 增加稳定 literal name、TypeBox schema、metadata、examples。
2. 在 `tool-dispatcher.ts` 映射到 provider adapter。
3. 在 `tools.test.ts` 覆盖 schema、PI name、dispatcher 参数映射和错误路径。
4. 更新 `docs/USAGE.md`。

## Tool Surface

默认 tool surface 保持小而语义化：

- 智谱：chat、web search、reader、rerank、embeddings、moderate。
- 亿企查：find APIs、describe API、call API、recommend bundle。

不把上游 API 一比一搬进 gateway。字段名按调用者表达优化，例如 `query / count / include / pageSize`，dispatcher 负责映射到上游的 `search_query / search_engine / top_n` 等字段。

亿企查刻意只暴露少量动作：

- `yiqicha.find_apis({ query, limit? })`
- `yiqicha.describe_api({ api })`
- `yiqicha.call_api({ api, params, noCache? })`
- `yiqicha.recommend_bundle({ bundle?, keyword?, include?, pageSize? })`

`recommend_bundle` 不调用上游，不产生亿企查计费请求。调用方必须显式选择并执行返回的 `{ api, params }` 计划。

## Document Processing Policy

智谱 OCR 和文件解析不是同一种能力：

- `/files/ocr`：小图片 OCR，支持 PNG/JPG/JPEG/BMP，8MB 内，返回文字行、坐标、可选置信度，`tool_type=hand_write`。
- `/files/parser/create` + `/files/parser/result/{task_id}/{format_type}`：异步文档解析，适合 PDF/Word/Excel/PPT/CSV/MD/TXT/HTML/图片，返回 text/download link/Markdown/版面结构等。
- `/files/parser/sync`：同步 Prime 级文档解析，适合在线链路，但仍必须有等待上限。
- `/reader`：URL 正文读取，不处理本地上传。

不要让 agent 直接选择智谱 `tool_type`。外部 schema 应使用调用者语义：

- `goal`：`plainText`、`markdown`、`layoutJson`、`tableExtraction`、`handwriting`、`coordinates`、`probability`
- `mode`：`sync`、`async`
- `quality`：`lowCost`、`balanced`、`highAccuracy`
- `waitMs`：等待上限

Gateway tool 返回智谱上游原始响应，不在 gateway 层改写 OCR/parser 字段。需要稳定业务形态的调用方应在自己的 adapter 内把上游响应归一化，例如：

```ts
type DocumentJobResult = {
	status: 'queued' | 'running' | 'succeeded' | 'failed'
	jobId?: string
	providerTaskId?: string
	text?: string
	markdown?: string
	downloadUrl?: string
	ocrLines?: Array<{ text: string; box?: unknown; probability?: unknown }>
	error?: string
	nextPollAfterMs?: number
	raw?: unknown
}
```

这个形态属于下游 adapter contract，不是 gateway RPC contract。字段抽取、转 JSON、摘要等后处理走两阶段：OCR/parser -> `zhipu.chat`，不要把 prompt 转发给 OCR/parser。

## Adapter Contract

Provider 插件负责：

- 上游鉴权和 base URL。
- OpenAPI path/body/form-data 映射。
- 上游错误解析。
- 请求预览脱敏。
- 调用历史。
- usage event。

示例：

```ts
this.usageRecorder.recordUsage({
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

Gateway 不暴露任意 provider raw OpenAPI 代理。新增外部能力应先变成稳定 tool 字面量和 schema，再进入 dispatcher；稳定 tool 可以原样返回对应上游 API 响应。

## API Catalog Priority

默认目录覆盖 GLM 常用模型、文档处理、搜索和 RAG/安全路径，不把图像/视频生成、agent、通用 files upload 放进常用面：

- 模型：`/paas/v4/chat/completions`、`/paas/v4/tokenizer`。
- 文档处理：`/paas/v4/layout_parsing`、`/paas/v4/files/ocr`、`/paas/v4/files/parser/create`、`/paas/v4/files/parser/result/{task_id}/{format_type}`、`/paas/v4/files/parser/sync`。
- 搜索/读取：`/paas/v4/web_search`、`/paas/v4/reader`。
- RAG/安全：`/paas/v4/embeddings`、`/paas/v4/rerank`、`/paas/v4/moderations`。

插件 UI 的“模型/工具”页只是 provider 内部测试面。新路径或临时参数要先沉淀成稳定 gateway tool，再暴露给外部 agent。

## HTTP Routes

External gateway:

- `GET /external-gateway/status`
- `GET /external-gateway/tools`
- `POST /external-gateway/call`
- `POST /external-gateway/call-batch`
- `ALL /external-gateway/rpc`

The Vite runtime host (`pnpm --filter @repo/project-external-api-gateway static`) uses `runtime-static` to inspect the mounted-route table and proxy host/plugin routes into the same runtime router, so plugins do not duplicate external API prefixes in Vite config.

Zhipu provider internal/debug routes:

- `GET /__pluxel/plugins/ZhipuProviderPlugin/zhipu/status`
- `POST /__pluxel/plugins/ZhipuProviderPlugin/zhipu/files-ocr`
- `POST /__pluxel/plugins/ZhipuProviderPlugin/zhipu/file-parser-create`
- `POST /__pluxel/plugins/ZhipuProviderPlugin/zhipu/file-parser-result`
- `POST /__pluxel/plugins/ZhipuProviderPlugin/zhipu/file-parser-sync`
- `POST /__pluxel/plugins/ZhipuProviderPlugin/zhipu/layout-parsing`
- `POST /__pluxel/plugins/ZhipuProviderPlugin/zhipu/openapi`
- `POST /__pluxel/plugins/ZhipuProviderPlugin/zhipu/chat-completions`
- `POST /__pluxel/plugins/ZhipuProviderPlugin/zhipu/web-search`
- `POST /__pluxel/plugins/ZhipuProviderPlugin/zhipu/reader`
- `POST /__pluxel/plugins/ZhipuProviderPlugin/zhipu/embeddings`
- `POST /__pluxel/plugins/ZhipuProviderPlugin/zhipu/rerank`
- `POST /__pluxel/plugins/ZhipuProviderPlugin/zhipu/moderations`

Provider internal routes may change faster than gateway tools.

## Billing

`billing` 是每次 `callTool(...)` 的强制归属边界。`userId / tenantId / traceId` 会写入 `UsageBillingPlugin`，用于成本、审计和 history。

`UsageBillingPlugin` 的价格表使用 `provider:operation[:model]` 作为 key。provider 插件可以记录 `request`、`token`、`page`、`image` 等不同 unit，具体单价通过 `upsertRate` 配置；未配置时成本按 `0` 估算，但用量仍会保留。

Billing UI 已暴露费率编辑入口。新增调用会按当前费率估算成本；已有明细不会被重算。

## Persistence

本项目仍处于开发阶段，本地数据视为可丢弃缓存。schema 变化时允许清空 SQLite / SignalDB / vault 本地状态并重建，不为旧字段、旧表或旧 namespace 增加兼容分支。

插件运行数据使用项目内 SQLite 文件：

```text
.pluxel/static/persistence/plugin-data/external-api-gateway.sqlite
```

当前持久化内容：

- gateway tokens：保存 token hash、启用/吊销状态和最近使用时间；UI 只展示预览。
- billing usage records / rates：账单明细和价格表会跨重启保留；UI 明细只加载最近 500 条，汇总按 SQLite 全量记录重建。
- provider call history：插件 UI 的 API 测试历史按 provider 统一保存。

清理本地开发数据：

```bash
rm -rf projects/external-api-gateway/.pluxel projects/external-api-gateway/dist projects/external-api-gateway/.turbo
```

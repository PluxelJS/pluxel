# External API Gateway

独立的 `runtime-static` 项目，用 Pluxel 插件系统接入外部 API。

当前插件：

- `ExternalGatewayPlugin`：外部 Cap'n Web RPC 入口，负责 `apiToken -> AuthedApi`、token 吊销、tool specs 和 tool dispatch。
- `UsageBillingPlugin`：上游用量/计费插件，按 `userId + provider + operation + model` 汇总调用、延迟、输入输出体积、单位用量和成本。
- `ZhipuProviderPlugin`：智谱 OpenAPI provider，依赖 shared usage recorder，保存 API Key，并为 gateway tools / 插件 UI 提供 OCR、文件解析、搜索、模型、embedding、rerank 等内部调用能力。

## Commands

```bash
pnpm --filter @repo/project-external-api-gateway dev
pnpm --filter @repo/project-external-api-gateway static
pnpm --filter @repo/project-external-api-gateway verify
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

外部 PI agent 复用正式导出的 `PiExtension`：

```ts
import { PiExtension } from '@repo/external-api-gateway-gateway/pi'

const pi = new PiExtension({
	token: apiToken,
	rpcUrl: 'http://127.0.0.1:3313/__pluxel/plugins/ExternalGatewayPlugin/gateway/rpc',
	billing: { userId: 'pi-agent', tenantId: 'tenant-a' },
})

const health = await pi.test()
if (!health.ok) throw new Error(health.error)
console.info(`External gateway token: ${health.tokenName}`)

const tools = pi.tools
const search = await pi.zhipu.webSearch({
	query: '智谱 GLM OpenAPI web_search',
	count: 5,
	recency: 'noLimit',
})
const chat = await pi.zhipu.chat({
	messages: [{ role: 'user', content: 'hello' }],
})
const plan = await pi.yiqicha.recommendBundle({
	bundle: 'profile',
	keyword: '北京智谱华章科技股份有限公司',
	include: ['basicInfo', 'shareholders', 'investments'],
})
const profileParts = await pi.callTools(
	plan.calls.map((call) => ({
		name: 'yiqicha.call_api',
		args: { api: call.api, params: call.params },
	})),
)

pi.dispose()
```

接 PI runtime 时，`PiExtension` 本身就是插件对象。PI 侧负责把 `tools` 注入模型，把模型返回的 tool call 交回 `handleToolCall`：

```ts
const pi = new PiExtension({ token: apiToken, rpcUrl, billing: 'pi-agent' })

const health = await pi.test()
if (!health.ok) throw new Error(health.error)

piAgent.registerTools(pi.tools)

piAgent.onToolCall(async (toolCall) => {
	return pi.handleToolCall(toolCall)
})
```

`PiExtension` 的 tools 是 PI/OpenAI-style function definitions，执行时只调用 ExternalGateway RPC。`pi.test()` 会实际认证 token、验证 RPC URL 可达，并拉取远端 tool specs；构造函数本身只保存配置，不做网络请求。

业务代码优先使用 `pi.zhipu.*` / `pi.yiqicha.*` typed wrapper；它们和 `callTool(...)` 复用同一套 TypeBox schema。需要对接模型 runtime 时才直接读取 `pi.tools` 并把 tool call 交给 `handleToolCall(...)`。`callTool('zhipu.web_search', args)` 仍保留，字面量 tool name 会推导对应 args 类型；动态字符串调用退回 `Record<string, unknown>`。需要一次提交多个显式 tool call 时用 `pi.callTools(...)`，每个结果独立返回。

`billing` 是每次 `callTool(...)` 的强制调用归属边界。`userId / tenantId / traceId` 会写入 `UsageBillingPlugin`，用于成本、审计和 history。`ExternalGatewayPlugin` 的 token 只做认证和吊销：有效 token 可调用 gateway tool；吊销后不可再认证。本地开发会自动创建默认 token；生产环境只有显式设置 `PLUXEL_EXTERNAL_GATEWAY_DEV_TOKEN` 时才会创建开发 token。

tool 名是稳定字面量：`zhipu.web_search`、`zhipu.chat`、`zhipu.reader`、`zhipu.rerank`、`zhipu.embeddings`、`zhipu.moderate`、`yiqicha.find_apis`、`yiqicha.describe_api`、`yiqicha.call_api`、`yiqicha.recommend_bundle`。字段名按 agent 表达优化，例如 `query / count / include / pageSize`，dispatcher 会映射到上游的 `search_query / search_engine / top_n` 等 provider 字段。二进制上传类接口只保留在 provider 内部 UI，不放进默认 PI tools。

`@repo/external-api-gateway-gateway/pi` 是外部 agent 复用入口；`@repo/external-api-gateway-gateway/tools` 是无 runtime 副作用的纯契约入口，可直接读取稳定 tool specs、TypeBox input schemas 和 typed args。

YiQiCha provider 面向 LLM agent 的 RPC surface 刻意保持很小，不把 128 个上游 API 暴露成 128 个 tool。默认 tool surface 只映射 4 个动作：

- `yiqicha.find_apis({ query, limit? })`：按业务意图查找语义 API key。
- `yiqicha.describe_api({ api })`：按语义 key 获取参数说明、必填项和响应示例。
- `yiqicha.call_api({ api, params })`：按语义 key 调用任意 YiQiCha API。
- `yiqicha.recommend_bundle({ bundle?, keyword?, include?, pageSize? })`：返回企业画像/风险/司法/完整画像的推荐调用计划，不调用上游、不产生 YiQiCha 请求计费。

这些方法按 tool 使用场景设计，而不是按上游 API 一比一搬运：agent 先用 `yiqicha.find_apis` 缩小候选，再用 `yiqicha.describe_api` 获取单个 API 参数，最后 `yiqicha.call_api` 执行。常见企业画像任务先走 `yiqicha.recommend_bundle` 拿到 `{ api, params }` 调用计划，再由外部按预算选择哪些 API 真正执行。gateway 不再替调用方打包企业画像，避免一个 tool call 隐式产生多次 YiQiCha 计费请求；需要并行执行多个 API 时用 Cap'n Web RPC 的 `callTools(...)` 或 HTTP `/gateway/call-batch`。

YiQiCha 上游按请求计费，分页 API 应尽量一次取满当前页来减少后续翻页调用。provider 会识别 request schema 里的 `pageSize` 参数：缺省时自动补 `pageSize: 50`，超过 50 时压到 50；如果 API 同时有 `page` 参数且调用方未传，会补 `page: 1`。不要把默认 pageSize 调小，除非某个接口明确证明返回体过大或上游限制更低。

`projects/zhipu-glm-openapi-client.zip` 中的 generated client 目前还是 placeholder；真正 typed helper 需要跑 zip 内 `refresh` 生成。External gateway 不再暴露 raw OpenAPI / provider 调用链，新增外部能力应先沉淀成稳定 tool 字面量和 schema，再进入 `tool-dispatcher.ts`。

## API Catalog Priority

当前默认目录覆盖 GLM 常用模型、文档处理、搜索和 RAG/安全路径，不把图像/视频生成、agent、通用 files upload 放进常用面：

- 模型：`/paas/v4/chat/completions`、`/paas/v4/tokenizer`。聊天、识图都走 `chat.completions`，通过 message content 传 `text` / `image_url`。
- 文档处理：`/paas/v4/layout_parsing`、`/paas/v4/files/ocr`、`/paas/v4/files/parser/create`、`/paas/v4/files/parser/result/{task_id}/{format_type}`、`/paas/v4/files/parser/sync`。
- 搜索/读取：`/paas/v4/web_search`、`/paas/v4/reader`。对话内 web search 通过 `chat.completions.tools` 透传。
- RAG/安全：`/paas/v4/embeddings`、`/paas/v4/rerank`、`/paas/v4/moderations`。

外部调用统一走 `callTool(...)`，以复用统一计费上下文。插件 UI 的“模型/工具”页只是按 provider 内部目录提供测试样例；新路径或临时参数需要先转成稳定 gateway tool，再暴露给外部 agent。

非 TypeScript 客户端可用 HTTP 调试入口：

- `GET /__pluxel/plugins/ExternalGatewayPlugin/gateway/tools`
- `POST /__pluxel/plugins/ExternalGatewayPlugin/gateway/call`
- `POST /__pluxel/plugins/ExternalGatewayPlugin/gateway/call-batch`

`call` / `call-batch` 使用 `Authorization: Bearer <token>` 或 `x-api-token` 认证，请求体与 RPC `callTool` / `callTools` 相同。

`/layout_parsing` 不再转发 prompt。需要“按提示提取字段/转 JSON/重写摘要”时，先调用 OCR，再把 OCR 结果和用户 prompt 交给 `/chat/completions` 做后处理；插件 UI 的 OCR 面板已经按这个两阶段流程组合返回 `{ ocr, postprocess }`。

## Adapter Contract

Provider 插件负责外部 API 适配、上游错误解析、请求预览脱敏和调用后产生 usage event。当前 `UsageBillingPlugin` 是唯一 `UsageRecorderPlugin` 实现；provider 只依赖 shared 里的 recorder 接口，不直接依赖 billing 包。未来如果要接多个计费 sink 或 quota/policy 插件，应优先保持 `UsageEvent` 稳定。

```ts
import { UsageRecorderPlugin } from '@repo/external-api-gateway-shared/usage'

class SomeProviderPlugin extends BasePlugin {
	constructor(private readonly usageRecorder: UsageRecorderPlugin) {
		super()
	}
}

setParamToken(SomeProviderPlugin, 0, UsageRecorderPlugin)
```

每次外部 API 调用后记录中性 usage event：

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

`@repo/external-api-gateway-shared/usage` 中的 `UsageEvent` 是 provider 和 billing 的边界。新增计费插件时建议先作为 recorder/sink 消费同一个事件结构，再按需要增加 quota/policy 的调用前检查。

Provider 插件可以保留 raw route 供插件 UI 和本地调试使用，但 ExternalGatewayPlugin 不再转发 raw OpenAPI 或 provider 内部调用接口。外部能力必须先进入 `tools.ts` 的稳定字面量和 schema，再由 `tool-dispatcher.ts` 映射到 provider。

`UsageBillingPlugin` 的价格表使用 `provider:operation[:model]` 作为 key。provider 插件可以记录 `request`、`token`、`page`、`image` 等不同 unit，具体单价通过 `upsertRate` 配置；未配置时成本按 `0` 估算，但用量仍会完整保留。

Billing UI 已暴露费率编辑入口，可直接配置 `provider / operation / model / unitName / unitCostCny`。新增调用会按当前费率估算成本；已有明细不会被重算。

## Persistence

本项目仍处于开发阶段，本地数据一律视为可丢弃缓存。为了让数据结构和接口代码可以快速收敛，schema 变化时允许直接清空 SQLite / SignalDB / vault 本地状态并重建，不保留向后兼容迁移，也不为旧字段、旧表或旧 namespace 增加兼容分支。

插件运行数据使用项目内 SQLite 文件：

```text
.pluxel/static/persistence/plugin-data/external-api-gateway.sqlite
```

当前持久化内容：

- gateway tokens：保存 token hash、启用/吊销状态和最近使用时间；UI 只展示预览。
- billing usage records / rates：账单明细和价格表会跨重启保留；UI 明细只加载最近 500 条，汇总按 SQLite 全量记录重建。
- provider call history：插件 UI 的 API 测试历史按 provider 统一保存。provider 特有字段进入 `details_json`，通用字段保留为结构化列。

清理本地开发数据可以直接删除：

```bash
rm -rf projects/external-api-gateway/.pluxel projects/external-api-gateway/dist projects/external-api-gateway/.turbo
```

数据库启动策略同样按开发阶段处理：如果 `gateway_meta.schema_version` 与当前代码不一致，启动时直接 drop 用户表并按当前 schema 重建。不要为历史开发数据写旧表迁移；需要调整表结构时优先改干净的数据模型和调用代码。

当前组织方式：

- gateway 插件只负责外部 token 认证/吊销、tool specs 和 tool dispatch。
- provider 插件负责 API key、OpenAPI path/body、上游响应解析和调用后落账。
- billing 插件作为所有 provider 的上游依赖，统一记录 `userId / tenantId / traceId / provider / operation / model / cost`。

## Zhipu Routes

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

`userId` 可以通过 `x-pluxel-user-id` / `x-user-id` header、URL query，或请求体字段传入。

Zhipu client 默认上游请求超时为 120 秒。插件 UI 的 GLM OCR 面板支持直接上传本地图片/PDF，也支持手工填写 OpenAPI `file` 字段；“后处理 Prompt”会在 OCR 完成后单独调用 chat，不会作为 `/layout_parsing` 参数转发。

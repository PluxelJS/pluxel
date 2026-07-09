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
const search = await pi.callTool('zhipu.web_search', {
	query: '智谱 GLM OpenAPI web_search',
	count: 5,
	recency: 'noLimit',
})
const chat = await pi.callTool('zhipu.chat', {
	messages: [{ role: 'user', content: 'hello' }],
})
const profile = await pi.callTool(
	'yiqicha.enterprise_profile',
	{
		keyword: '北京智谱华章科技股份有限公司',
		include: ['basicInfo', 'shareholders', 'investments'],
	},
	{ billing: { userId: 'pi-agent', tenantId: 'tenant-a', traceId: 'trace-company-001' } },
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

`billing` 是每次 `callTool(...)` 的强制调用归属边界。`userId / tenantId / traceId` 会写入 `UsageBillingPlugin`，用于成本、审计和 history。`ExternalGatewayPlugin` 的 token 只做认证和吊销：有效 token 可调用 gateway tool；吊销后不可再认证。本地开发会自动创建默认 token；生产环境只有显式设置 `PLUXEL_EXTERNAL_GATEWAY_DEV_TOKEN` 时才会创建开发 token。

tool 名是稳定字面量：`zhipu.web_search`、`zhipu.chat`、`zhipu.reader`、`zhipu.rerank`、`zhipu.embeddings`、`zhipu.moderate`、`yiqicha.find_apis`、`yiqicha.describe_api`、`yiqicha.call_api`、`yiqicha.enterprise_profile`、`yiqicha.enterprise_risk`、`yiqicha.enterprise_legal`。字段名按 agent 表达优化，例如 `query / count / include / pageSize`，dispatcher 会映射到上游的 `search_query / search_engine / top_n` 等 provider 字段。二进制上传类接口只保留在 provider 内部 UI，不放进默认 PI tools。

`@repo/external-api-gateway-gateway/pi` 是外部 agent 复用入口；`@repo/external-api-gateway-gateway/tools` 是无 runtime 副作用的纯契约入口，可直接读取稳定 tool specs。

YiQiCha provider 面向 LLM agent 的 RPC surface 刻意保持很小，不把 128 个上游 API 暴露成 128 个 tool。默认 tool surface 只映射 6 个动作：

- `yiqicha.find_apis({ query, limit? })`：按业务意图查找语义 API key。
- `yiqicha.describe_api({ api })`：按语义 key 获取参数说明、必填项和响应示例。
- `yiqicha.call_api({ api, params })`：按语义 key 调用任意 YiQiCha API。
- `yiqicha.enterprise_profile({ keyword, include?, pageSize? })`：组合企业画像信息。
- `yiqicha.enterprise_risk({ keyword, include?, pageSize? })`：组合企业经营/资产类风险。
- `yiqicha.enterprise_legal({ keyword, include?, pageSize? })`：组合企业司法风险。

这些方法按 tool 使用场景设计，而不是按上游 API 一比一搬运：agent 先用 `yiqicha.find_apis` 缩小候选，再用 `yiqicha.describe_api` 获取单个 API 参数，最后 `yiqicha.call_api` 执行；常见任务直接走 overview 组合 tool。这样 prompt 里只需要 6 个稳定工具，不需要塞入完整 API catalog，也避免模型选择 `1002` 这类不可读数字 code。内部仍保留 code/key 映射和 catalog，数字只作为 provider 实现细节。

`projects/zhipu-glm-openapi-client.zip` 中的 generated client 目前还是 placeholder；真正 typed helper 需要跑 zip 内 `refresh` 生成。External gateway 不再暴露 raw OpenAPI / provider 调用链，新增外部能力应先沉淀成稳定 tool 字面量和 schema，再进入 `tool-dispatcher.ts`。

## API Catalog Priority

当前默认目录覆盖 GLM 常用模型、文档处理、搜索和 RAG/安全路径，不把图像/视频生成、agent、通用 files upload 放进常用面：

- 模型：`/paas/v4/chat/completions`、`/paas/v4/tokenizer`。聊天、识图都走 `chat.completions`，通过 message content 传 `text` / `image_url`。
- 文档处理：`/paas/v4/layout_parsing`、`/paas/v4/files/ocr`、`/paas/v4/files/parser/create`、`/paas/v4/files/parser/result/{task_id}/{format_type}`、`/paas/v4/files/parser/sync`。
- 搜索/读取：`/paas/v4/web_search`、`/paas/v4/reader`。对话内 web search 通过 `chat.completions.tools` 透传。
- RAG/安全：`/paas/v4/embeddings`、`/paas/v4/rerank`、`/paas/v4/moderations`。

外部调用统一走 `callTool(...)`，以复用统一计费上下文。插件 UI 的“模型/工具”页只是按 provider 内部目录提供测试样例；新路径或临时参数需要先转成稳定 gateway tool，再暴露给外部 agent。

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

插件运行数据使用项目内 SQLite 文件：

```text
.pluxel/static/persistence/plugin-data/external-api-gateway.sqlite
```

当前持久化内容：

- gateway tokens：保存 token hash、启用/吊销状态和最近使用时间；UI 只展示预览。
- billing usage records / rates：账单明细和价格表会跨重启保留；UI 明细只加载最近 500 条，汇总按 SQLite 全量记录重建。
- Zhipu test history：插件 UI 的 OCR/API 测试历史跨重启保留。OCR 请求预览会脱敏 data URL/base64 文件内容，只保留来源和体积摘要。

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

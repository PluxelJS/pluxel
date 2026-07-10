# External API Gateway Usage

本文档面向外部程序、agent runtime 和调试脚本。一般优先使用 TypeScript `PiExtension`；非 TypeScript 客户端可用 HTTP fallback。

## Endpoint

默认本地 RPC URL：

```text
http://127.0.0.1:3313/external-gateway/rpc
```

本地启动：

```bash
pnpm --filter @repo/project-external-api-gateway dev
pnpm --filter @repo/project-external-api-gateway static
```

`dev` 是 Vite + runtime-static dev host；runtime-static 会把已挂载的 runtime HTTP routes 代理进 Pluxel runtime HTTP router。`static` 直接运行 `src/static.ts` 的独立 runtime server，更接近生产入口。不要用普通 Vite server 测试 RPC；那种情况下 GET 可能返回 SPA HTML，POST 会 404。

默认开发 token：

```text
dev-zhipu-token-change-me
```

生产环境不要依赖默认 token。创建、吊销 token 通过插件 UI 或 admin RPC 完成。

## TypeScript Client

```ts
import { PiExtension, yiqichaBundleCalls } from '@repo/external-api-gateway-gateway/pi'

const pi = new PiExtension({
	token: apiToken,
	rpcUrl: 'http://127.0.0.1:3313/external-gateway/rpc',
	billing: { userId: 'pi-agent', tenantId: 'tenant-a' },
})

const health = await pi.test()
if (!health.ok) throw new Error(health.error)

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

const profileParts = await pi.callTools(yiqichaBundleCalls(plan))

pi.dispose()
```

`PiExtension` 构造函数只保存配置，不做网络请求。`pi.test()` 会认证 token、验证 RPC URL 可达，并拉取远端 tool specs。

## Cap'n Web Batch

Cap'n Web HTTP batch session 是一次性对象。已知要调用多个 RPC 时，创建一个 fresh batch，不要逐个 `await`；把所有 promise 一次性传给 `Promise.all`。这样 `authenticate`、capability 获取和多个方法调用会合并到同一个 HTTP batch request。

```ts
const api = pi.batch()

const basicInfo = api.callTool({
	name: 'yiqicha.call_api',
	args: { api: 'getBasicInfo', params: { keyword: '北京智谱华章科技股份有限公司' } },
	billing: { userId: 'pi-agent', traceId: 'company-001' },
})

const shareholders = api.callTool({
	name: 'yiqicha.call_api',
	args: {
		api: 'getEnterprisePartners',
		params: { keyword: '北京智谱华章科技股份有限公司', page: 1, pageSize: 50 },
	},
	billing: { userId: 'pi-agent', traceId: 'company-001' },
})

const [basic, holders] = await Promise.all([basicInfo, shareholders])
```

不要保存 `const api = pi.batch()` 给后续交互复用。batch 结束后 stub 不能继续使用，需要下一轮调用时重新创建。

如果只想让服务端并行执行多个工具并分别返回成功/失败结果，用 `pi.callTools(...)`。如果要利用 Cap'n Web promise pipelining，把多个 RPC 压进一个 HTTP batch，用 `pi.batch()`。

## Agent Tools

`pi.tools` 是 OpenAI/PI-style function definitions。导给模型的 function name 使用 `provider_action`，例如：

- `zhipu_chat`
- `zhipu_web_search`
- `zhipu_reader`
- `yiqicha_find_apis`
- `yiqicha_describe_api`
- `yiqicha_call_api`
- `yiqicha_recommend_bundle`

内部 gateway canonical name 仍是 `provider.action`，例如 `zhipu.web_search`。`PiExtension.handleToolCall(...)` 会把 agent tool name 自动映射回内部名。

```ts
const pi = new PiExtension({ token: apiToken, rpcUrl, billing: 'pi-agent' })

const health = await pi.test()
if (!health.ok) throw new Error(health.error)

piAgent.registerTools(pi.tools)

piAgent.onToolCall(async (toolCall) => {
	return pi.handleToolCall(toolCall)
})
```

业务代码优先使用 `pi.zhipu.*` / `pi.yiqicha.*` typed wrapper。只有在接模型 runtime 时才直接读取 `pi.tools` 并把 tool call 交给 `handleToolCall(...)`。

## Tool Selection

当前默认 gateway tools：

- `zhipu.chat`：OpenAI-compatible chat completions。
- `zhipu.web_search`：联网搜索，适合当前事实、新闻、来源发现。
- `zhipu.reader`：读取 URL 正文。
- `zhipu.rerank`：按 query 重排候选文档。
- `zhipu.embeddings`：创建文本 embedding。
- `zhipu.moderate`：文本或 JSON 内容安全分类。
- `yiqicha.find_apis`：按业务意图搜索亿企查 API。
- `yiqicha.describe_api`：获取单个亿企查 API 的参数和响应说明。
- `yiqicha.call_api`：按 semantic key 调用一个亿企查 API。
- `yiqicha.recommend_bundle`：返回企业画像/风险/司法/完整画像的推荐调用计划，不调用上游。

亿企查常见流程：

1. 用 `yiqicha.recommend_bundle(...)` 免费拿计划。
2. 调用方按预算选择要执行的 API。
3. 用 `yiqichaBundleCalls(plan, { only: [...] })` 转成显式 `yiqicha.call_api` 调用。
4. 用 `pi.callTools(...)` 或 `pi.batch()` 并行执行。

分页 API 默认 `pageSize: 50`，超过 50 会压到 50；如果 API 有 `page` 参数且未传，会补 `page: 1`。

## Document Processing

OCR 和文件解析都可能耗时。对外使用时按需求选择能力，不要让 agent 直接猜智谱上游 endpoint 或 `tool_type`。

调用前尽量提供：

- `fileName / mimeType / sizeBytes / fileType`
- `goal`：`plainText`、`markdown`、`layoutJson`、`tableExtraction`、`handwriting`、`coordinates`、`probability`
- `mode`：`sync` 或 `async`
- `quality`：`lowCost`、`balanced`、`highAccuracy`
- `waitMs`：愿意等待的最长时间

推荐规则：

| 输入/需求 | 推荐能力 | 上游实现映射 |
| --- | --- | --- |
| PNG/JPG/JPEG/BMP，8MB 内，只要图片文字行、坐标、可选置信度，尤其手写识别 | `zhipu_ocr` | `/files/ocr`，`tool_type=hand_write` |
| PDF/Word/Excel/PPT/CSV/MD/TXT/HTML 或图片，需要 Markdown/text、表格、版面结构、图片产物 | `zhipu.file_parse` | `/files/parser/create`，后续用 `zhipu.file_parse_result` 映射 `/files/parser/result/{task_id}/{format_type}` |
| 在线链路必须一次请求返回，文件满足同步解析限制，且需要 Prime 级解析 | `zhipu_file_parse` with `mode=sync` | `/files/parser/sync`，`tool_type=prime-sync` |
| 大文件、复杂版式、批量导入、可后台处理 | `zhipu.file_parse` with `mode=async` | `/files/parser/create`，保存 `task_id` 后用 `zhipu.file_parse_result` 轮询 |
| URL 页面内容读取，不是本地文件上传 | `zhipu.reader` | `/reader` |
| 图片/PDF OCR 后按业务字段抽取 JSON | 两阶段：OCR/parser -> chat | 先走 OCR/parser，再走 `zhipu.chat` |

Gateway 返回智谱上游原始响应。业务侧如果需要稳定读取层，建议在自己的 adapter 中归一化为：

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

如果业务 adapter 支持等待策略，可以在 `waitMs` 内完成时归一化为 `succeeded`，未完成时归一化为 `queued/running + jobId + nextPollAfterMs`；底层 RPC 不应无限阻塞。字段抽取、转 JSON、摘要等需求作为 OCR/解析后的 `zhipu.chat` 后处理，不转发到 OCR 或 parser。

当前二进制上传类接口仍主要保留在 provider UI 和内部 route；正式进入默认 agent tool surface 前，需要先沉淀稳定 schema 和 job 状态协议。

## HTTP Fallback

非 TypeScript 客户端可用 HTTP 调试入口：

- `GET /external-gateway/tools`
- `POST /external-gateway/call`
- `POST /external-gateway/call-batch`

认证使用 `Authorization: Bearer <token>` 或 `x-api-token`。

`call` 请求体与 RPC `callTool` 相同：

```json
{
  "name": "zhipu.web_search",
  "args": { "query": "GLM OpenAPI", "count": 5 },
  "billing": { "userId": "pi-agent", "traceId": "search-001" }
}
```

`call-batch` 请求体与 RPC `callTools` 相同：

```json
{
  "calls": [
    {
      "name": "yiqicha.call_api",
      "args": { "api": "getBasicInfo", "params": { "keyword": "智谱" } },
      "billing": "pi-agent"
    }
  ]
}
```

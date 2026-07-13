# 平台适配器设计规范

本文是 `projects/chatbots` 平台适配器的规范架构。Telegram、KOOK 已采用这里定义的 Bot registry、原生 Bot API、`$` 扩展和多账号寻址。

## 一句话模型

```text
PlatformPlugin -> BotRegistry -> Bot -> native platform API
                                     -> $.raw / $.conversation / $.lifecycle
                                     -> native events
                                     -> optional ChatHub projection
```

- 平台插件管理账号集合，是可被其他 Pluxel 插件注入的 capability。
- 一个 `Bot` 代表一个已配置的平台账号；Bot 本身就是原生平台 API。
- Bot 顶层只暴露平台原生 API，所有本项目增加的能力放在唯一的 `$` 命名空间。
- ChatHub 是可选的跨平台投影，不是平台 SDK 的所有者，也不能限制平台原生能力。
- 类型优先复用平台维护的包；没有可信类型源时才从 OpenAPI 等规范生成。

公共类命名使用 `{Platform}Plugin`、`{Platform}Bot` 和 `{Platform}ApiClient`。Plugin 即使承担 ChatHub adapter 投影，也不能把完整的平台 capability 缩减成一个 adapter 外壳。

## 公共调用体验

平台专属插件应直接依赖平台插件：

```ts
@Plugin({ name: 'KookModerationPlugin' })
export class KookModerationPlugin extends BasePlugin {
	constructor(private readonly kook: KookPlugin) {
		super()
	}

	override init() {
		const bot = this.kook.bots.require('community')
		bot.events.group_message.on(async (event, signal) => {
			await bot.sendMessage({
				target_id: event.target_id,
				content: 'received',
			})
		})
	}
}
```

原生 API 直接位于 Bot 顶层：

```ts
await bot.sendMessage(payload)
await bot.getGuildList({ page: 1 })
await bot.createDirectMessage(payload)
```

平台之外增加的能力统一放在 `$`：

```ts
await bot.$.raw.call('sendMessage', payload, { signal })
await bot.$.raw.request('POST', '/message/create', { json: payload }, { signal })

const channel = bot.$.channel(channelId)
await channel.send('hello')
await channel.reply(messageId, 'done')
await channel.upsert('progress: 50%')
await channel.transient('temporary', { ttlMs: 5_000 })

await bot.$.start()
await bot.$.stop()
bot.$.info // stable, non-secret local account/API metadata
bot.$.status
```

`$` 是保留名称。不要再平行增加 `$raw`、`$tool`、`$control`，也不要把
conversation builder 等高级能力伪装成平台官方 endpoint。推荐内部结构：

```ts
export interface KookBotExtensions {
	readonly info: Readonly<{ id: string; baseUrl: string }>
	readonly raw: KookRawApi
	readonly status: Readonly<KookBotStatus>
	channel(id: string): KookConversation
	direct(userId: string): KookDirectConversation
	start(): Promise<void>
	stop(): Promise<void>
}
```

各平台不必拥有相同的 `$` 成员。只有命名规则和职责边界统一，平台语义不应被强行统一。

## Bot registry

插件公开只读 registry，而不是可被外部写入的对象：

```ts
export interface BotRegistry<Bot> extends Iterable<Bot> {
	readonly size: number
	get(id: string): Bot | undefined
	require(id: string): Bot
	has(id: string): boolean
	keys(): IterableIterator<string>
	values(): IterableIterator<Bot>
	entries(): IterableIterator<readonly [string, Bot]>
}
```

调用方使用：

```ts
const optional = telegram.bots.get('notifications')
const required = telegram.bots.require('notifications')
```

不推荐 `Record<string, Bot>` 或用 Proxy 模拟 `bots[id]`：它们会暴露修改能力、原型键问题，
也让“账号不存在”缺少明确错误。若某个平台需要更短的调用，可增加严格别名：

```ts
telegram.bot('notifications') // 等价于 telegram.bots.require(...)
```

registry 的 key 是本地稳定配置 ID，不是远端 Bot ID。远端 ID 在首次鉴权前不存在，且更换
token 后可能变化；本地 ID 才能稳定关联 Vault、管理状态、路由和业务配置。

Bot 在配置存在后就应进入 registry，不应等 gateway 在线后才出现。HTTP API 可用性、事件连接
状态和配置存在性是不同维度：

```ts
const bot = kook.bots.require('community')
bot.$.status.phase // offline | connecting | online | error

// gateway 暂时断开时，原生 HTTP API 仍可能可用。
await bot.sendMessage(payload)
```

鉴权成功后，Bot 可以公开平台原生的只读身份对象 `selfInfo`，使业务不必重复调用 `getMe` 或从
管理投影反查；未鉴权时为 `undefined`。本地 ID、规范化 API base 等非敏感稳定信息放在冻结的
`bot.$.info`，token、secret、内部 client 和 Context 不得进入 info、status 或 JSON 序列化结果。

Bot 已拥有 owner Context 时，不应再从构造参数重复注入 logger。使用
`ctx.logger.with({ platform, accountId })` 创建账号级 logger，并只把明确的 token/base/fetch/signal
字段传给底层 API client，不能用 `{ ...botOptions }` 把 Context、Hub binding 或事件对象扩散到
HTTP client 的配置和生命周期中。

## 连接状态与诊断快照

“已配置”“HTTP API 可鉴权”“事件连接在线”是三个不同事实。Bot 的 `$.status` 应是不可变、
平台专属的实时快照，而不是单个 `connected: boolean`，也不能把管理数据库当作状态源：

```ts
bot.$.status.phase // offline | connecting | online | error | destroyed

telegramBot.$.status.polling
// { offset, consecutiveFailures, currentBackoffMs, lastPollAt, lastUpdateId, lastUpdateAt }

kookBot.$.status.gateway
// { phase, sessionId, lastSequence, counters, timestamps, currentBackoffMs, lastError }
```

连接状态机拥有快照，Bot 将其投影到 `$.status`，Web Management 再按需投影用于展示；依赖方向不能
反过来。诊断只保留固定字段、累计计数和最近时间点，不保存无界事件历史。token、完整连接 URL、
webhook secret 和带认证信息的错误对象不得进入快照。

状态更新遵循以下规则：

- 每次公开快照都创建冻结的新对象，嵌套诊断对象也冻结，调用方不能改写内部状态；
- 鉴权成功后保留 `selfInfo`，短暂断线不能清除 Bot 身份；
- transient failure 进入 error/backoff 并保留最近错误，下一次成功连接或 poll 才清除；
- stop/destroy 必须立即终止 heartbeat、retry timer、poll request 和 transport registration；
- replacement/start generation 使用 abort lease，失效 generation 的异步完成不得覆盖当前状态；
- heartbeat 和空 poll 可以更新 Bot 内部快照，但管理投影只发布有意义的状态变化、错误或新事件，
  避免固定周期持久化写放大；
- polling 与 WebSocket 不共享“万能连接基类”，只共享纯 backoff、cancel delay 和 lease 原语。

连接实现应提供可注入的最低层 transport factory（例如 WebSocket factory），使握手、heartbeat、
退避和 teardown 能用确定性的 fake transport 测试；不能把真实网络作为状态机单测的前提。

### WebSocket resume 与事件顺序

平台提供 session/sequence 恢复协议时，普通网络断开应优先恢复原 session，而不是立即创建新会话：

```text
disconnect
  -> request resume URL(sessionId, lastSequence)
  -> HELLO
  -> send RESUME(lastSequence)
  -> RESUME_ACK
  -> online
```

所有 WebSocket frame 必须进入单一异步 tail；不能从多个 `message` callback 并发执行 codec、事件
listener 和 Hub 投影。带序列号的事件只按连续序列消费：

- `sn <= lastSequence` 是重复帧，计数后丢弃；
- `sn === lastSequence + 1` 立即消费，再连续 drain 已缓冲后继帧；
- `sn > lastSequence + 1` 进入以 SN 为 key 的有界 buffer；
- buffer 超过上限说明缺口无法健康收敛，关闭 socket 触发恢复，不能无限占用内存；
- 只有事件处理完成后才推进 `lastSequence`，避免 handler 未完成却宣称已经消费；
- HELLO 与 resume ACK 都必须有明确 timeout；resume HELLO 失败、ACK 超时或平台明确要求 hard reconnect 时，清空 session、SN 和 buffer，
  回退到全新连接；普通网络抖动保留它们。

resume session 默认只属于当前 Bot 生命周期，不写入管理投影。若平台确实需要跨进程恢复，必须使用
明确的加密持久化契约、版本和过期策略，不能顺手把 session ID 或完整 gateway URL 写入普通状态库。
诊断快照可以公开是否正在恢复、buffer 大小以及 resume/duplicate/out-of-order 计数，但不能公开完整
认证 URL。

只有平台插件可以改变 registry。创建、更新、删除账号的方法由平台插件明确提供，并负责 Vault、
状态投影和 Bot 生命周期；业务插件只能读取 Bot。

## Bot、Plugin 与 ChatHub 的边界

推荐拆分如下：

```text
api/             纯平台 HTTP client、类型、endpoint inventory
bot/             单账号生命周期、事件连接、$ 高级能力
registry/        Bot 集合和配置协调
codec/           平台对象 <-> JSON-safe ChatMessage
management/      可选 UI、RPC 和状态投影
plugin.ts        Pluxel capability 组合根
```

硬依赖放构造函数，可选管理面放 `ctx.webManagement.use()`。ChatHub 投影属于 optional plugin
integration，平台插件应使用 `this.plugins.use(ChatHubPlugin, callback)` 动态挂载；不能因为 Hub
未启用就阻止 Bot 原生 API、gateway/polling 或 raw events 启动。Hub 替换或停用时只卸载
transport，不能销毁 Bot。Bot 的 timer、gateway、polling、observer 和 transport registration 都
必须有明确 disposer，并由平台插件生命周期最终回收。

ChatHub 不得知道平台 SDK 类型。adapter 可以把原生事件投影成 `ChatMessage`，但不能把 Bot、
session、方法、`Blob` 或循环对象塞进通用消息。

共享的 registry、token config、optional capability binding、退避和 abort lease 只从
`@repo/chatbots-adapter-kit` 的对应子入口导入。平台 codec 直接依赖 `@repo/chatbots-contracts`；
不能为了取得这些原语或消息类型而依赖 Hub 默认出口。连接状态机仍属于具体平台。

### 多账号寻址

多 Bot 后，平台种类与账号实例必须是两个字段：

```ts
type ChatAddress = {
	platform: 'kook'
	accountId: 'community'
	conversationId: string
}
```

- 入站排序和出站路由键：`(platform, accountId, conversationId)`。
- 平台用户的默认稳定身份键：`(platform, actorId)`。
- 如果产品需要租户隔离，应由 access policy 显式加入 tenant/account scope，不能依赖字符串拼接。
- 不要把 `kook/community` 整体伪装成新的平台名称，否则 capability 查询、身份关联和统计都会失真。

Hub 对该地址执行独立的入站和出站会话队列；adapter 注册 transport 时必须同时提供稳定的
`platform/accountId`，不能退回单 transport 覆盖多个账号。

## 原生事件

平台事件集合是有限、可枚举的公开协议，必须用命名的 `EvtChannel` 属性表达，不能重新实现
`Map<string, handler>`，也不能要求调用方从一个宽泛 raw payload 中反复判断事件类型。事件面分为
两个层级：

- `bot.events.<name>` 只观察一个账号，参数不重复携带 Bot；
- `plugin.events.<name>` 聚合该插件管理的所有账号，第一个参数是来源 Bot。

两层使用同一份静态 event inventory：

```ts
const bot = telegram.bots.require('notifications')

bot.events.callback_query.on(async (query, update, signal) => {
	if (!signal.aborted) await bot.answerCallbackQuery({ callback_query_id: query.id })
})

telegram.events.callback_query.on(async (sourceBot, query, update, signal) => {
	// 聚合 channel 天然携带来源 Bot，无需再按账号 ID 反查。
})
```

命名遵循平台原生 payload，不增加第二套翻译名。Telegram 使用 `edited_message`、
`callback_query` 等 `TelegramUpdate` 字段；KOOK notice 使用 `message_btn_click`、
`added_reaction` 等原生 type。分类与兜底 channel 也必须显式且有限：Telegram 的 `update` 接收
所有原始 Update；KOOK 的 `event/message/group_message/private_message/notice/unknown_notice`
分别表达原始事件、消息分类和未知 notice。

所有 channel 使用 Pluxel `EvtChannel`：`on()` 注册会绑定调用方 Context 并随其 effects 自动清理，
仍返回幂等 disposer，也可通过 `{ signal }` 主动控制订阅。分发使用 `emitSettled()` 等待异步
listener 并隔离失败；一个 listener 的异常不能阻止同 channel 的其他 listener，不能阻止精确事件
channel，也不能使 gateway ack 或 polling offset 丢失。平台事件只有在 codec 明确支持时才额外
投影到 ChatHub，不能为了跨平台统一而丢掉 callback query、reaction、guild mutation 等语义。

事件 inventory 与 endpoint inventory 遵循相同的生成规则。外部类型包可枚举事件字段时，codegen
从权威声明生成可审阅 TXT，`api:check` 双向检查漂移，macro 只把字段名数组内联到 runtime；类型
仍直接映射外部声明，不生成副本。Telegram 即从 `@gramio/types` 的 `TelegramUpdate` 同时生成
`updates.txt`，新字段或删除字段都会令 CI 失败。没有外部机器可读来源的平台维护一份经过类型
`satisfies` 校验的本地常量，并由映射类型保证每个事件都有 channel 和精确 payload。

## API 类型与 endpoint inventory

平台 API 有三个彼此独立的事实：

1. 参数和返回值类型；
2. 方法名、HTTP method 和 path；
3. 认证、multipart、错误 envelope、限流等 transport 规则。

不要用一个 `unknown` endpoint 表假装解决了三者，也不要为已有权威类型包重新抄一套类型。

### 类型源优先级

按以下顺序选择权威来源：

1. 平台或成熟社区维护的 TypeScript 类型包；
2. 平台发布的 OpenAPI/JSON Schema/机器可读规范；
3. 可审阅的本地声明和 endpoint inventory；
4. 最后才是手写零散类型。

Telegram 是第一种情况：

```ts
import type { APIMethodParams, APIMethodReturn, APIMethods } from '@gramio/types'

type CallArgs<Method extends keyof APIMethods> =
	undefined extends APIMethodParams<Method>
		? [payload?: APIMethodParams<Method>, options?: CallOptions]
		: [payload: APIMethodParams<Method>, options?: CallOptions]
```

本仓库只实现 Telegram transport 和 endpoint inventory，不复制 Telegram 对象模型。

### codegen 与 macro 不是同一阶段

```text
remote package / OpenAPI / schema
              |
              | explicit codegen (developer/CI)
              v
 committed generated types + endpoints.txt
              |
              | Pluxel build-time macro
              v
 inlined readonly endpoint metadata
              |
              | one shared native prototype installer
              v
 NativeApi prototype -> ApiClient + Bot
```

codegen 可以解析远端规范并写文件，但必须是显式、可复现的开发命令。正常启动、测试和生产构建
不得访问网络，也不得静默改写源码。生成结果应提交 Git，使平台升级表现为可审阅 diff。

macro 只读取仓库内已提交的静态文件并返回可序列化值。它消除运行时 `fs` 和 endpoint 表解析，
不负责网络同步，不应包含 token、环境状态或动态业务决策。

## 推荐的生成目录

```text
src/api/
  source/
    openapi.json          # 可选：固定版本的上游规范
    provenance.json       # 来源 URL/package/version/checksum
  generated/
    api-types.ts          # codegen 输出，不手改
  endpoints.txt           # codegen 输出或人工审阅 inventory
  endpoints.macro.ts      # build-only parser/validator
  endpoints.ts            # runtime-visible inlined constant
  request.ts              # auth/envelope/multipart/limiting
  native.ts               # shared native method prototype
  client.ts               # standalone call()/raw client
  index.ts                # public exports only
scripts/
  update-api-source.ts    # 可选：显式联网更新固定规范
  generate-api.ts         # 显式 codegen
```

推荐 scripts：

```json
{
	"scripts": {
		"api:update-source": "node --experimental-strip-types scripts/update-api-source.ts",
		"api:generate": "node --experimental-strip-types scripts/generate-api.ts",
		"api:check": "node --experimental-strip-types scripts/generate-api.ts --check"
	}
}
```

`api:check` 应在内存或临时目录重新生成并逐字节比较已提交文件，发现漂移时失败，而不是修改工作树。
推荐把“联网更新来源”和“离线生成”拆成两个命令：`api:update-source` 是开发者显式执行的供应链
操作，记录来源版本和 checksum；`api:generate`、`api:check` 只消费 lockfile/node_modules 或
已提交的本地规范。CI 不应依赖远端文档站临时可用，也不能在未经审阅时接受远端内容变化。

所有生成文件首行应标明生成器和来源，例如：

```ts
// Generated by scripts/generate-api.ts from source/openapi.json; DO NOT EDIT.
```

不要写生成时间或绝对路径，它们会制造无意义 diff。

### 从外部 TypeScript 包同步

TypeScript interface 在运行时已经擦除。macro 无法通过 `Object.keys(APIMethods)` 枚举只有类型声明
的外部包，也不应靠正则表达式解析 `.d.ts`。根据外部包能力选择：

- 包同时导出 runtime schema/inventory：codegen 脚本读取该导出，确定性地产生 `endpoints.txt`；
- 包只有 `.d.ts`：类型直接 import，codegen 使用 TypeScript compiler API 遍历导出 interface，或读取
  平台另行发布的机器可读 endpoint 清单；
- 包只有类型且不存在可靠枚举源：维护可审阅 TXT，并让 `api:check` 用 compiler API 验证每个 TXT
  名称都是 interface key，同时验证 interface 的每个 API 方法都出现在 TXT 中。

Telegram 属于“类型直接复用、inventory 单独同步”：参数和返回值始终来自 `@gramio/types`，
生成器只同步方法名/HTTP metadata，不能把 GramIO 声明复制进仓库。若外部包升级后方法集合变化，
`api:check` 必须失败并展示完整集合 diff。

## 从 OpenAPI 生成

OpenAPI codegen 至少需要验证：

- 每个公开 operation 有稳定且唯一的 `operationId`；
- HTTP method、path、query/body/multipart 位置完整；
- request/response 与错误 envelope 明确；
- 重复方法名、未知 method、缺失 schema 直接失败；
- 输出顺序稳定，不包含时间戳和机器绝对路径。
- `operationId` 不与 `Object.prototype`、`then`、`call`、`request`、`$`、`events`、`id`、`selfInfo` 等 Bot/ApiClient 保留成员冲突。

例如生成：

```text
sendMessage POST /message/create json
getGuildList GET /guild/list query
createAsset POST /asset/create multipart
```

以及纯类型接口：

```ts
export interface KookAutoApi {
	sendMessage(payload: SendMessageInput, options?: CallOptions): Promise<Result<SendMessageOutput>>

	getGuildList(
		payload?: GetGuildListInput,
		options?: CallOptions,
	): Promise<Result<GetGuildListOutput>>
}
```

生成器不要生成 84 份几乎相同的 fetch 方法体。类型接口和 metadata 足够，运行时实现由一个
`call()` 和共享 prototype installer 提供。

如果上游规范不可靠，可以提交经过修正的本地 OpenAPI overlay；不要在生成后的 TypeScript 中
手工补丁，因为下一次生成会覆盖且难以审计。

## TXT inventory 与 macro

适合人工审阅的 inventory 示例：

```text
# methodName HTTP path [encoding]
sendMessage POST /message/create json
getGuildList GET /guild/list query
createAsset POST /asset/create multipart
```

macro 文件只做确定性解析和结构验证：

```ts
import { readFileSync } from 'node:fs'

export function platformApiEndpoints(): Array<
	readonly [name: string, method: string, path: string, encoding: string]
> {
	const source = readFileSync(new URL('./endpoints.txt', import.meta.url), 'utf8')
	const names = new Set<string>()
	const output: Array<readonly [string, string, string, string]> = []

	for (const originalLine of source.split(/\r?\n/)) {
		const line = originalLine.replace(/#.*/, '').trim()
		if (!line) continue
		const fields = line.split(/\s+/)
		if (fields.length !== 4) throw new Error(`Invalid endpoint: ${originalLine}`)
		const [name, method, path, encoding] = fields
		if (!/^[A-Za-z_$][\w$]*$/.test(name!)) throw new Error(`Invalid name: ${name}`)
		if (names.has(name!)) throw new Error(`Duplicate endpoint: ${name}`)
		if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method!))
			throw new Error(`Invalid HTTP method: ${method}`)
		if (!path!.startsWith('/')) throw new Error(`Invalid path: ${path}`)
		if (!['query', 'json', 'multipart'].includes(encoding!))
			throw new Error(`Invalid encoding: ${encoding}`)
		names.add(name!)
		output.push([name!, method!, path!, encoding!] as const)
	}

	return output
}
```

runtime 模块用 macro import：

```ts
import { platformApiEndpoints } from './endpoints.macro.ts' with { type: 'macro' }
import type { PlatformAutoApi } from './generated/api-types.ts'

export type PlatformEndpoint = readonly [
	name: keyof PlatformAutoApi,
	method: HttpMethod,
	path: string,
	encoding: Encoding,
]

// macro 返回值经过完整运行时验证后，只在这一个边界收窄类型。
export const PLATFORM_ENDPOINTS = platformApiEndpoints() as readonly PlatformEndpoint[]
```

macro 输出必须是普通 JSON-like 字面量。不要返回函数、class、Map、platform client 或运行时资源。

## 最小成本地把方法放到 Bot 上

一个 Bot 不应拥有几十或几百个 endpoint 闭包，独立 client 与 Bot 也不应各安装一份相同方法。
使用一个不公开 raw/call 的 `NativeApi` 基类承载具名方法；standalone client 与受管 Bot 作为兄弟
子类共享该 prototype，并各自实现唯一的 symbol invoke：

```ts
const invokeNative = Symbol('invokeNative')

abstract class PlatformNativeApi {
	protected abstract [invokeNative](name: keyof PlatformAutoApi, payload?: unknown): unknown
}

// 类型层：声明生成的方法存在。
interface PlatformNativeApi extends PlatformAutoApi {}

// 运行时层：整个包中每个 endpoint 只有这一份函数。
for (const [name] of PLATFORM_ENDPOINTS) {
	Object.defineProperty(PlatformNativeApi.prototype, name, {
		configurable: false,
		enumerable: false,
		value(this: PlatformNativeApi, payload?: unknown) {
			return this[invokeNative](name, payload)
		},
	})
}

export class PlatformApiClient extends PlatformNativeApi {
	async call<Name extends keyof PlatformAutoApi>(
		name: Name,
		...args: Parameters<PlatformAutoApi[Name]>
	): Promise<Awaited<ReturnType<PlatformAutoApi[Name]>>> {
		const endpoint = endpointMap.get(name)
		if (!endpoint) throw new Error(`Unknown endpoint: ${String(name)}`)
		return this.request(endpoint, ...args) as never
	}

	protected [invokeNative](name: keyof PlatformAutoApi, payload?: unknown) {
		return this.call(name, payload as never)
	}
}
```

Bot 组合私有 client，但只继承无 escape hatch 的 native method base：

```ts
export class PlatformBot extends PlatformNativeApi {
	#api: PlatformApiClient
	readonly $: PlatformBotExtensions
	readonly events: PlatformBotEvents

	constructor(
		readonly id: string,
		options: PlatformBotOptions,
	) {
		super()
		this.#api = new PlatformApiClient(options.api)
		this.events = createPlatformBotEvents(options.ctx)
		this.$ = createPlatformBotExtensions(this, options)
	}

	protected [invokeNative](name: keyof PlatformAutoApi, payload?: unknown) {
		return this.#api.call(name, payload as never)
	}
}
```

因此：

- `bot.sendMessage()` 是直接的原生方法；
- Bot 不需要额外的 API facade；
- endpoint 方法不成为 Bot own property；
- 每个 Bot 只保存账号、连接和 `$` 状态；
- standalone client 与所有 Bot 的同名 endpoint 引用严格相等；
- 不需要 Proxy，也不需要运行时 `Object.setPrototypeOf()` 改写继承链。

不要直接让 Bot 继承一个公开 `call/$raw/$tool` 的 client，否则会破坏顶层原生 API、`$` 扩展能力
的边界。禁止在 constructor 中循环绑定 endpoint，也禁止在 Client 与 Bot prototype 重复安装。

## Codegen 与共享 prototype

当前生成链路：

```text
definitions.txt / endpoints.txt
  -> build-time source macro
  -> endpoint metadata
  -> shared API prototype
  -> AbstractBot declaration merge
  -> concrete Bot
```

约束：

- endpoint 清单独立、可 diff；
- macro 让生产运行不读取 TXT；
- 原生具名方法直接出现在 Bot 上；
- 方法函数存在于共享 prototype，而不是每实例分配；
- raw API 和 conversation helper 不污染跨平台协议。

- 用静态 `NativeApi` 基类替代额外的 `Object.setPrototypeOf()` prototype 链，并让 Client/Bot 共享唯一方法实现；
- 用唯一 `$` 收纳 raw、工具和控制面，避免多个 `$xxx` namespace 漂移；
- registry 对外只读，并区分本地配置 ID 与远端 Bot ID；
- 类型来源、endpoint metadata 与 transport 分层，不用 `unknown` 表掩盖漂移；
- manager 不再同时承担 persistence、RPC、SSE、webhook 和所有生命周期职责；
- 多账号在 ChatHub 中有显式 `accountId`，不把账号拼进 platform 名称。

## 验证门槛

新适配器至少需要以下证据：

1. `api:check` 证明 codegen 产物没有漂移。
2. inventory parser 测试覆盖非法行、重复 endpoint、未知 method/encoding。
3. inventory 与类型权威源同步；新增或删除 endpoint 会让 CI 明确失败。
4. 类型测试证明代表性方法的输入和返回值来自权威类型，而不是 `unknown`。
5. standalone client 与两个 Bot 的同一 endpoint 方法引用相等，且 endpoint 不是 Client/Bot 子类或实例 own property。
6. `$` helper 只调用公开原生 API 或 `$.raw`，不复制认证与 envelope 逻辑。
7. 每请求 signal 与 Bot owner signal 正确组合；停止 Bot 会中止其所有连接和请求。
8. event inventory 可枚举且无漂移；Bot/Plugin 两层 channel 类型精确，disposer 幂等且异常隔离。
9. 多 Bot 的入站排序和出站回复不会串到另一个账号。
10. 生产 bundle 不包含 `node:fs`、TXT 内容读取路径或 codegen 脚本。
11. package root 和 `/api` 子入口只导出有意公开的类型/能力，`index.ts` 不含实现。
12. 真实运行至少完成鉴权、一个原生 API 调用、一个原始事件和一次 ChatHub 往返。

不要用“endpoint 数量相等”作为唯一同步证明。数量相同仍可能发生一删一增；应比较完整、有序的
方法名和 metadata，并通过代表性编译期调用验证参数与返回值。

## 新适配器检查表

- [ ] Bot 顶层只包含平台原生 API。
- [ ] 本项目扩展只存在于 `$`。
- [ ] `selfInfo` 保留原生身份类型，`$.info` 不包含 secret 或内部对象。
- [ ] Bot 从 Context 派生账号级 logger，底层 client options 使用显式字段白名单。
- [ ] 平台插件公开只读 `bots` registry。
- [ ] Bot 从配置存在起可发现，连接状态单独表达。
- [ ] 原生事件使用静态 `EvtChannel` 属性，保留权威类型并绑定 Bot。
- [ ] 同时提供 Bot 局部与 Plugin 聚合事件面，且只有一个 event inventory。
- [ ] raw/分类/精确事件 channel 的分发顺序与错误隔离有测试。
- [ ] ChatHub 投影保持 JSON-safe，且带独立 `platform/accountId`。
- [ ] ChatHub 通过 optional `plugins.use()` 接入；无 Hub 时平台原生能力仍可运行。
- [ ] 优先复用外部类型包，没有重复造类型。
- [ ] codegen 显式、确定、可 `--check`，构建不访问网络。
- [ ] macro 只内联已提交的静态 metadata。
- [ ] endpoint 方法只安装在共享 prototype 一次。
- [ ] API、Bot、registry、codec、management 包边界清晰。
- [ ] 生命周期、取消、错误、限流和 multipart 有平台级测试。

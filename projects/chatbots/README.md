# Chatbots for Pluxel

基于当前 Pluxel static runtime 的聊天机器人插件集群。

## 现在包含什么

- `ChatHubPlugin`：transport-neutral 消息路由、富消息规划、时间窗去重、会话内串行、有界背压、处理器隔离和有界停机 drain。
- `ChatAccessPlugin`：跨平台统一用户、角色与分层权限；业务状态持久化，Workbench只是投影。
- `ChatCommandsPlugin`：把 `@pluxel/commands` 的结构化命令绑定为跨平台消息路由，并提供权限、响应投影和中间件。
- `ChatBuiltinsPlugin`：`/ping`、`/help`、`/account`、`/link`、`/status`。
- `ChatSandboxPlugin`：无需平台凭据即可进行 HTTP 或管理界面端到端测试。
- `TelegramPlugin`：Telegram long polling capability，使用 Wretch 出站能力和 Vault 多账号管理。
- `KookPlugin`：KOOK gateway capability、完整 v3 原生 API 和 Vault 多账号管理。
- `TelegramHubBridgePlugin` / `KookHubBridgePlugin`：独立、可省略的平台 codec 与 ChatHub transport 桥。

## 运行

```bash
pnpm install
pnpm --filter @repo/project-chatbots start
```

默认地址为 `http://127.0.0.1:3314`，直接打开即为 Pluxel 管理界面。adapter 始终运行以提供配置页面；没有账号配置时 Bot registry 为空，不会连接外部平台。`start` 与 `static` 都使用带 `staticRuntimeVitePlugin` 的 Vite host，插件源码不会绕过工具链直接执行。

同一账号的保存、删除、重连和断开操作严格串行，不同账号互不阻塞；并发管理 RPC 不会造成 Vault 配置与运行中 Bot 版本倒置。

该项目使用 fixed catalog，runtime enabled list 采用 memory snapshot。这样升级后新增的 adapter/基础能力不会被旧的持久化 enabled list 隐藏；平台连接状态、用户权限、Vault 凭据和管理数据仍然持久化。

沙箱接口位于插件路由：

```bash
curl -s http://127.0.0.1:3314/__pluxel/plugins/ChatSandboxPlugin/api/messages \
  -H 'content-type: application/json' \
  -d '{"text":"/ping"}'
```

响应中的 `replies` 应包含 `pong`。查看状态和历史：

```text
GET  /__pluxel/plugins/ChatSandboxPlugin/api/status
GET  /__pluxel/plugins/ChatSandboxPlugin/api/messages
POST /__pluxel/plugins/ChatSandboxPlugin/api/reset
```

## 启用 Telegram

插件详情中的 `Telegram 状态` Tab 只保留运行摘要和快捷添加入口；点击 Workbench 一级导航的 `Bots`，再从二级导航进入 Telegram 独立管理台。Telegram 自主声明 `bots` navigation group，宿主负责形成统一入口，不存在枚举平台的中央 Workbench 插件。管理首页以全宽卡片搜索和选择账号；点击账号或“添加 Bot”会打开可独立切换、关闭和恢复的 Workbench 原生 Tab。为账号填写稳定的本地 Bot ID 与 Token 后点击“创建并连接”，详情 Tab 提供完整 Polling 诊断、连接设置和运行控制。Token 只写入持久化加密 Vault；Workbench 从运行中 BotManager 取得安全 snapshot，只能看到掩码，不再把连接状态复制到数据库。

Telegram API client 从 `@repo/chatbots-telegram/api` 导出并要求传入 Wretch base。180 个 Bot API 方法与 `@gramio/types` 的 `APIMethods` 对齐：参数和返回值直接使用 GramIO 类型，`Blob` 输入会自动编码为 `attach://` multipart。独立 client 与受管 Bot 继承同一个 native API prototype；原生方法位于顶层，allowlist raw call 只位于 `client.$.raw` / `bot.$.raw`。

`telegramBot.$.status.polling` 提供冻结的 offset、连续失败次数、当前退避、最近 poll 和最近 update 快照。空 poll 只更新 Bot 内存诊断，不触发管理投影持久化；恢复成功或收到 update 时才发布有意义变化。

Telegram API 返回 `parameters.retry_after` 后，该 Bot 的后续 HTTP 调用会等待平台指定的冷却期；失败调用本身不会被 client 自动重放。

## 启用 KOOK

插件详情中的 `KOOK 状态` Tab 只保留运行摘要和快捷添加入口；点击 Workbench 一级导航的 `Bots`，再从二级导航进入 KOOK 独立管理台。KOOK 和未来平台都通过相同 group 自主注册自己的 route、grant 和 bundle。管理首页以全宽卡片搜索和选择账号；每个账号详情和创建流程使用独立 Workbench Tab。为每个账号填写稳定 Bot ID、Token 和可选 API Base，插件会为每个 Vault 配置创建独立 `KookBot`，调用 `user/me` 后分别建立 gateway。详情显示 Gateway phase、连接时长、最近事件、SN、连接/重连/Resume、Ping/Pong、乱序/重复、缓冲、溢出和退避指标，并提供鉴权测试、重连、断开及带确认的删除；群聊 conversation id 为 `channel:<channelId>`，私聊为 `direct:<userId>`。

完整 KOOK 原生 client 从 `@repo/chatbots-kook/api` 导出并要求传入 Wretch base。84 个 v3 endpoints 由 `endpoints.txt` 在构建期通过 macro 内联；`api:check` 双向比较 inventory 与 `KookAutoApi`。client 与 `KookBot` 共享唯一 native API prototype；raw 位于 `$`，频道/私聊 bound sender、上传、回复和编辑等增强只位于 `bot.$`，不再公开平行 `$tool`。

`bot.$.channel(channelId, defaults)` 与 `bot.$.direct(target, defaults)` 是无消息状态的绑定发送句柄：创建时快照目标和默认消息参数，可用 `temp_target_id` 固定频道消息的单用户可见性，并通过 `withSignal(signal)` 组合事件取消；句柄始终继承 Bot owner 生命周期。`sendOrEdit({ msg_id, content })` 显式输入并返回消息 ID，因而单机内存与集群 Redis/DB 可以复用同一写入逻辑；消息引用协调和持久 scheduler 不伪装成平台能力。

`renderKookCard()` 提供项目常用的精简 Card 布局：默认 `secondary`/`lg` 内容卡，包含标题、KMarkdown sections 与 context；link 或 return-value actions 自动进入单独的 `invisible` 卡片。它只负责确定性 JSON 渲染，不接管 `temp_target_id` 可见性、发送或按钮事件处理；高级模块继续使用同一入口导出的原生 `Card` 类型。

需要全量 Card 时使用 `Card.Message` 与 `renderKookCardMessage()`。原生类型覆盖所有官方 module，并在类型层约束 invisible module subset、section accessory、paragraph、button 与 countdown 组合；序列化边界再验证最多 5 张 card、总计 50 个 module 及各元素数量、文本、URL、颜色和时间戳。简写 renderer 委托同一边界，不维护平行协议。

`kookBot.$.status.gateway` 提供冻结的连接 phase、session ID、最后 SN、事件/心跳/重连计数、最近时间点与当前退避。普通网络断开会携带 session/SN 恢复；所有 frame 经单一异步 tail 串行处理，事件按连续 SN 消费，重复帧被丢弃，乱序帧进入有界 buffer，无法收敛时主动重连。只有 listener 完成后才推进 SN，因此恢复点不会越过尚未完成的业务处理。gateway transport factory 可注入，握手、resume、heartbeat、断线退避和 teardown 都可以脱离真实网络做确定性测试。

KOOK API 返回 HTTP `429 Retry-After` 后，同一 Bot 的后续 HTTP 调用会等待冷却期；调用方仍明确处理本次失败结果。

## 源码组织

外部平台边界统一位于 `platforms/*`：Telegram、KOOK、Sandbox 以及两个可选 Hub bridge；
产品和业务能力位于 `plugins/*`：Hub、Access、Commands 与 Builtins；无插件实例身份的共享实现
位于 `packages/*`。目录只表达所有权和依赖方向，不承担平台清单注册：每个平台仍通过自己的
Workbench contract 自主加入统一的 `bots` navigation group。

包默认入口只导出稳定插件能力与作者需要的类型；Router、Gateway、codec、Workbench RPC/DTO、Manager 和内部 registry 不通过 barrel 泄漏。每个平台遵循 `plugin.ts -> bot/manager.ts -> bot/bot.ts -> api/client.ts`：主插件只组合生命周期，Manager 拥有 Vault/registry/replacement，Bot 拥有单账号连接与原生事件，API client 只处理平台 HTTP；可选管理平面完整收进 `workbench/`。

两个平台的 Workbench 各自拥有 contract、route、grant、挂载点、鉴权方法和原生诊断映射，并通过相同 `bots` navigation group 自主出现在一个一级入口下。它们共同复用 `platform-kit/bot-admin` 的 RPC 转发、snapshot 订阅清理、凭据掩码，以及 `workbench-ui` 的 launcher、表单和操作壳层；平台自行声明 `/accounts/:accountId` 与 `/create` 非导航 route，公共 UI 只调用宿主 `openTab()`，不依赖宿主组件或 router。统一的是管理机制和交互，不是平台清单、Bot、Gateway/Polling 或业务状态的所有权。

`telegram` 与 `kook` 平台包不依赖 `contracts` 或 `hub`，只提供原生 API、Bot registry、原始事件、连接状态机、Vault 账号生命周期和可选管理 UI。它们 required-depend 官方 `WretchPlugin`。`telegram-hub-bridge` 与 `kook-hub-bridge` 是独立桥接插件，拥有平台 codec、checkpoint-critical 入站 consumer 和 ChatHub transport。

bridge 的入站和出站工作绑定自身生命周期：stop、启动回滚或 HMR replacement 会取消在途 Hub receive/API send，再卸载 transport 与 consumer。入站 consumer 为每个事件冻结注册顺序并 fail-fast；运行中新增或移除 consumer 只影响下一个 checkpoint。

依赖声明遵循“谁拥有实例，谁负责安装”：宿主项目声明 React、Mantine、Tabler、Pluxel runtime 和 catalog 插件；插件包将 singleton 或 required plugin capability 声明为 peer，仅Workbench使用的 UI 包是 optional peer，headless host 可以不安装。`contracts`、`platform-kit` 和 `workbench-support` 这类没有实例身份的源码库保留普通 dependency；后者只服务 Access/Sandbox 的持久管理投影，不进入平台实现。边界测试会拒绝平台包重新导入 Hub/contracts。

当前 `@repo/chatbots-*` 是本 workspace 的私有源码包；可以被同仓库其他插件独立依赖和注入，但尚未作为 npm 公共包发行。真正外部分发需要统一确定公开 scope、版本线、构建产物和发布责任，不能只去掉 `private` 就假装完成。

新平台适配器必须遵循 [平台适配器设计规范](docs/PLATFORM_ADAPTERS.md)：平台插件公开只读 Bot registry，Bot 本身优先暴露原生 API，本项目增加的 raw、conversation 和生命周期能力统一收纳到 `$`。该文档同时说明如何从外部类型包或 OpenAPI 显式 codegen 出类型与 endpoint inventory，再通过 Pluxel macro 内联 metadata，并用共享 prototype 让所有 Bot 以最低实例成本获得具名 API 方法。

受管 Bot 鉴权后通过 `bot.selfInfo` 暴露平台原生身份；`bot.$.info` 只包含本地账号 ID 和规范化 API 地址等冻结的非敏感信息。每个 Bot 从 Pluxel Context 派生带 `platform/accountId` 的 logger，底层 HTTP client 只接收显式白名单配置，不保留 Hub、事件或 Context 引用。

## 内容与匹配

`chat` builder 负责相邻文本合并、JSON 安全序列化和显式多消息意图：

```ts
return chat.batch(chat.of('任务 ', chat.link(url, '详情')), chat.image(previewUrl, '预览'))
```

`chat.batch()` 是 fail-fast；`chat.batchBestEffort()` 会继续发送后续条目，并在 `ChatSendResult.failures` 中返回失败索引。平台因能力不足产生的单消息拆分仍由 Hub planner 负责，两种语义不会混淆。

同一 `(platform, accountId, conversationId)` 的逻辑发送会完整执行后再开始下一次发送，因此 batch 或平台自动拆分不会被并发调用穿插；不同会话仍可并行。入站和出站队列默认每会话最多保留 256 个、全局最多保留 4096 个待处理调用，满载时明确拒绝而不是无限占用内存。`hub.snapshot()` 与 sandbox `/status` 的 `router` 字段公开当前队列深度、handler/observer 失败、逻辑消息发送失败、拒绝和 drain timeout 计数；取消不计作业务失败。

Hub 的时间窗去重是进程内优化，不是持久化 exactly-once。并发重复消息共享第一次 dispatch 的结果；只有成功 dispatch 才提交去重记录，失败或取消会回滚并允许重试。Telegram 只在原始事件和所有入站 consumer 完成后推进 update offset，KOOK 只在 consumer 完成后推进连续 SN；bridge 中的 Hub receive 失败因此不会越过 checkpoint。崩溃边界仍可能重放。会产生外部副作用的 handler 应使用 `messageKey(message)` 作为稳定幂等键，并把幂等结果保存在自己的业务状态中。

planner 会先逐 block 校验 transport capabilities，再决定 mixed、拆分或平台原子布局；声明 `mixedContent: true` 不代表可以接收未声明的 block。`atomicBlocks` 用于“支持，但必须作为独立平台操作发送”的内容。严格模式直接报错，默认 best-effort 会把不支持的媒体变成带类型标记的可读文本，并合并相邻文本以减少平台调用。超出平台文本上限时会在不切断 Unicode surrogate pair 的前提下自动拆分，只有第一条保留 reply quote。

通用媒体 block 的 `url` 只表示可由目标 transport 使用的跨平台资源地址。Telegram 入站 `file_id` 绑定具体 Bot 账号，bridge 不再把它伪装成 `telegram:file:*` URL；通用消息只得到可读的附件占位文本，JSON-safe 的原生文件标识留在 `metadata.telegramAttachments`。需要下载、复用或处理该文件的 Telegram 专属插件应直接消费原生 update。

Hub 只保留实际使用的 transport、handler 和 observer。固定关键词匹配属于具体业务插件；在出现真实调用点前不进入 Hub 公共 API。

## 用户与权限

每条入站消息都会把 `(platform, actorId)` 投影为稳定 `ChatUser`；`accountId` 单独参与消息路由，因此同一平台用户不会仅因通过两个 Bot 到达而被拆成两人。命令默认声明 `cmd.<command.name>` 权限并采用 deny 默认值；公开命令必须在 carrier binding 显式写 `permission: false`，或将声明设为 `{ defaultEffect: 'allow' }`。用户覆盖优先于角色，角色按 rank 从高到低决策，最后才使用节点默认值；exact 规则优先于最长 `prefix.*`。

用户可发送 `/account` 查看统一身份，发送 `/link` 生成 5 分钟有效的一次性关联码，再到另一个平台发送 `/link <code>` 合并身份、角色和 grants。

Workbench UI 的 browser Contract 与 server entry 分离：

```ts
const ChatUi = workbenchContract.define({
	views: {},
})

const ChatWorkbench = workbench.extension({
	contract: ChatUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})
```

Contract module 可被浏览器直接导入；entry 只留在 server module。artifact key 和路径转换由工具链负责，插件不
重复 plugin ID，也不写 `fileURLToPath(new URL(...))`。

## 增加业务插件

命令型能力依赖 `ChatCommandsPlugin` 并在 `init()` 注册：

```ts
import { defineCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'

const weather = defineCommand({
	name: 'weather.lookup',
	description: '查询天气',
	behavior: { kind: 'query', world: 'open' },
	input: obj({ city: Type.String() }),
	output: obj({ forecast: Type.String() }),
	execute: async ({ city }) => ({ forecast: await lookupWeather(city) }),
})

@Plugin({ name: 'WeatherPlugin' })
export class WeatherPlugin extends BasePlugin {
	constructor(private readonly commands: ChatCommandsPlugin) {
		super()
	}

	override init() {
		this.ctx.effects.own(
			this.commands.register(weather, {
				routes: ['weather'],
				positionals: ['city'],
				permission: false,
				respond: ({ forecast }) => forecast,
			}),
		)
	}
}
```

route、alias、positionals 和 flags 属于 carrier binding；命令本身只描述结构化输入、输出与行为。同一个只要求基础 `CommandContext` 的 `Command` 可以同时绑定到 Chat、KOOK、CLI 或 runtime catalog。只有读取 `message`、`user`、`reply` 等事实的实现才声明 `ChatCommandContext`，它不能注册到基础 runtime catalog。已匹配但参数无效的命令会安全回复并停止 Hub 管线，未知 route 则继续交给后续 handler。

非命令的跨平台能力直接依赖 `ChatHubPlugin`，通过 `registerHandler()` 订阅稳定的 `ChatMessage`。平台专属能力直接依赖平台插件，而不是扩张通用协议：

```ts
@Plugin({ name: 'TelegramModerationPlugin' })
export class TelegramModerationPlugin extends BasePlugin {
	constructor(private readonly telegram: TelegramPlugin) {
		super()
	}

	override init() {
		this.telegram.events.callback_query.on(async (bot, query, _update, signal) => {
			await bot.$.raw.call('answerCallbackQuery', { callback_query_id: query.id }, { signal })
		})
	}
}
```

也可以通过 `telegram.bots.require('notifications')` 主动取得指定 Bot，再使用 `bot.events.message.on(...)` 只监听该账号。Telegram 与 KOOK 都提供静态可枚举的 `plugin.events.<name>` 聚合 channel 和 `bot.events.<name>` 局部 channel；它们由 Pluxel `EvtChannel` 管理订阅生命周期与错误隔离。原始事件不会被塞进 `ChatMessage`；跨平台消息保持 JSON-safe，平台能力仍可独立组合为 Pluxel 插件依赖。

只在 KOOK 消息上下文中成立的命令用 `defineKookCommand()` 定义，并通过 `register()` 注册。它没有结构化
output 或额外的 `respond` 分支；handler 直接使用 `KookCommandContext` 完成回复：

```ts
import { defineKookCommand } from '@repo/chatbots-kook'

const inspect = defineKookCommand({
	name: 'kook.inspect',
	description: 'Inspect the current KOOK message.',
	behavior: { kind: 'query', world: 'closed' },
	input: obj({ detail: Type.String() }),
	async execute({ detail }, ctx) {
		await ctx.reply(`${ctx.bot.id}:${ctx.event.author_id}:${detail}`)
	},
})

@Plugin({ name: 'KookInspectPlugin' })
class KookInspectPlugin extends BasePlugin {
	constructor(private readonly kook: KookPlugin) {
		super()
	}

	override init() {
		this.kook.commands.register(inspect, {
			prefix: '.',
			routes: ['inspect'],
			positionals: ['detail'],
		})
	}
}
```

如果同一业务命令还要给 CLI、Workbench、Agent 或 runtime 使用，就继续用普通 `defineCommand()` 返回结构化
output，再用 `bind()` 明确 KOOK 的终端回复投影：

```ts
this.kook.commands.bind(weather, {
	routes: ['weather'],
	positionals: ['city'],
	respond: async ({ forecast }, ctx) => {
		await ctx.reply(forecast)
	},
})
```

`prefix` 省略时为 `/`，也可由每个 binding 配置为 `.`、`!` 等 1–16 个不含空白的字符；descriptor usage
会包含实际前缀。`register()` 只接受 `defineKookCommand()` 的 KOOK 原生命令；`bind()` 只接受基础 `Command`，并强制提供
`respond`。两者都会从 caller Context 取得消费插件 owner，自动随该插件停止、替换或启动回滚撤销 route，调用方
不应再包一层 `effects.own()`。手动 `registration.dispose()` 只撤销发布，已经接纳的调用可以完成；owner 停止则会
abort 并 drain 在途调用。命令中的额外 IO 应传递 `ctx.signal`，`ctx.reply()` 已自动把它传给 KOOK HTTP 请求。
命中 route 后不会再把同一 event 交给 Hub bridge。要求 `KookCommandContext` 的原生命令不能进入 runtime 通用
catalog。

更多当前设计取舍见 [docs/DESIGN.md](docs/DESIGN.md)。

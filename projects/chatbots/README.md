# Chatbots for Pluxel

基于当前 Pluxel static runtime 的聊天机器人插件集群。

## 现在包含什么

- `ChatHubPlugin`：transport-neutral 消息路由、富消息规划、时间窗去重、会话内串行、有界背压、处理器隔离和有界停机 drain。
- `ChatAccessPlugin`：跨平台统一用户、角色与分层权限；业务状态持久化，管理面只是投影。
- `ChatCommandsPlugin`：分层路由、alias、flags、中间件和默认拒绝的权限节点。
- `ChatBuiltinsPlugin`：`/ping`、`/help`、`/status`。
- `ChatSandboxPlugin`：无需平台凭据即可进行 HTTP 或管理界面端到端测试。
- `TelegramPlugin`：Telegram long polling capability，带 Vault 管理面板。
- `KookPlugin`：KOOK gateway capability、完整 v3 API client 和 Vault 管理面板。
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

打开 Pluxel 中的 `Telegram Bot` 设置页，为账号填写稳定的本地 Bot ID 与 Token 后点击“保存并连接”。同一插件可管理多个账号；Token 只写入持久化加密 Vault，SignalDB 和浏览器端只能看到是否存在及掩码。设置页可选择账号执行鉴权测试、重连、断开和删除。

Telegram API client 从 `@repo/chatbots-telegram/api` 导出。180 个 Bot API 方法与 `@gramio/types` 的 `APIMethods` 对齐：参数和返回值直接使用 GramIO 的 Bot API 10.1 类型，`Blob` 输入会自动编码为 `attach://` multipart。`api:generate/api:check` 使用 TypeScript compiler API 从外部声明同步完整方法集合及 `TelegramUpdate` 事件字段，macro 再于构建期内联两个 inventory。独立 client 与受管 Bot 继承同一个 native API prototype，180 个方法在整个包中只安装一份；Bot 不会因此暴露 client 的 `call`。

`telegramBot.$.status.polling` 提供冻结的 offset、连续失败次数、当前退避、最近 poll 和最近 update 快照。空 poll 只更新 Bot 内存诊断，不触发管理投影持久化；恢复成功或收到 update 时才发布有意义变化。

Telegram API 返回 `parameters.retry_after` 后，该 Bot 的后续 HTTP 调用会等待平台指定的冷却期；失败调用本身不会被 client 自动重放。

## 启用 KOOK

打开 Pluxel 中的 `KOOK Bot` 设置页，为每个账号填写稳定 Bot ID、Token 和可选 API Base。插件会为每个 Vault 配置创建独立 `KookBot`，调用 `user/me` 后分别建立 gateway。设置页支持多账号选择、鉴权测试、重连、断开及删除；群聊 conversation id 为 `channel:<channelId>`，私聊为 `direct:<userId>`。

完整 KOOK OpenAPI client 从 `@repo/chatbots-kook/api` 导出。84 个 v3 endpoints 由 `endpoints.txt` 在构建期通过 macro 内联；`api:check` 会双向比较 inventory 与 `KookAutoApi`，避免只有数量相同的假同步。独立 client 与 `KookBot` 共享唯一 native API prototype，但 client 的 `$raw/$tool` 不会沿继承链泄漏到 Bot；raw、频道/私聊 conversation、上传、回复、编辑、跟踪和临时消息工具统一位于 `bot.$`。

`kookBot.$.status.gateway` 提供冻结的连接 phase、session ID、最后 SN、事件/心跳/重连计数、最近时间点与当前退避。普通网络断开会携带 session/SN 恢复；所有 frame 经单一异步 tail 串行处理，事件按连续 SN 消费，重复帧被丢弃，乱序帧进入有界 buffer，无法收敛时主动重连。只有 listener 完成后才推进 SN，因此恢复点不会越过尚未完成的业务处理。gateway transport factory 可注入，握手、resume、heartbeat、断线退避和 teardown 都可以脱离真实网络做确定性测试。

KOOK API 返回 HTTP `429 Retry-After` 后，同一 Bot 的后续 HTTP 调用会等待冷却期；调用方仍明确处理本次失败结果。

## 源码组织

包默认入口只导出稳定插件能力与作者需要的类型；Router、Gateway、codec、management RPC/DTO、parser 和内部 registry 不通过 barrel 泄漏。跨平台协议按 `content/message/transport` 拆分；Hub 按 `handler/delivery/router/plugin` 拆分；adapter 的 registry、原子账号存储、串行器、retry gate、退避和 abort lease 位于独立 `adapter-kit` 明确子入口；命令按 `types/parser/registry/middleware/plugin` 拆分。

`telegram` 与 `kook` 平台包不依赖 `contracts` 或 `hub`，只提供原生 API、Bot registry、原始事件、连接状态机、Vault 账号生命周期和可选管理 UI。`telegram-hub` 与 `kook-hub` 是独立桥接插件，拥有平台 codec、确认型入站投影和 ChatHub transport。平台专属插件因此只安装并依赖平台包；只有跨平台消息产品才同时安装对应 bridge 与 Hub。

bridge 的入站和出站工作绑定自身生命周期：stop、启动回滚或 HMR replacement 会取消在途 Hub receive/API send，再卸载 transport 与 projection。确认型 projection 为每个事件冻结注册顺序；运行中新增或移除 projection 只影响下一个 checkpoint。

依赖声明遵循“谁拥有实例，谁负责安装”：宿主项目声明 React、Mantine、Tabler、Pluxel runtime 和 catalog 插件；插件包将 singleton 或 required plugin capability 声明为 peer，仅管理面使用的 UI 包是 optional peer，headless host 可以不安装。`contracts`、`adapter-kit` 这类会随实现一起使用且没有实例身份的库保留普通 dependency。边界测试会拒绝平台包重新导入 Hub/contracts。

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

Hub 的时间窗去重是进程内优化，不是持久化 exactly-once。并发重复消息共享第一次 dispatch 的结果；只有成功 dispatch 才提交去重记录，失败或取消会回滚并允许重试。Telegram 只在原始事件和所有确认型 projection 完成后推进 update offset，KOOK 只在 projection 完成后推进连续 SN；bridge 中的 Hub receive 失败因此不会越过 checkpoint。崩溃边界仍可能重放。会产生外部副作用的 handler 应使用 `messageKey(message)` 作为稳定幂等键，并把幂等结果保存在自己的业务状态中。

planner 会先逐 block 校验 transport capabilities，再决定 mixed、拆分或平台原子布局；声明 `mixedContent: true` 不代表可以接收未声明的 block。`atomicBlocks` 用于“支持，但必须作为独立平台操作发送”的内容。严格模式直接报错，默认 best-effort 会把不支持的媒体变成带类型标记的可读文本，并合并相邻文本以减少平台调用。超出平台文本上限时会在不切断 Unicode surrogate pair 的前提下自动拆分，只有第一条保留 reply quote。

大量固定关键词不要注册一串普通 handler。使用 `hub.registerMatcher()`，它会把 patterns 编译成压缩 alphabet + TypedArray DFA 的 Aho-Corasick automaton；`claim` matcher 可按 priority 短路，`observe` matcher 不认领消息。

## 用户与权限

每条入站消息都会把 `(platform, actorId)` 投影为稳定 `ChatUser`；`accountId` 单独参与消息路由，因此同一平台用户不会仅因通过两个 Bot 到达而被拆成两人。命令默认声明 `cmd.<route>` 权限并采用 deny 默认值；公开命令必须显式写 `permission: false`，或将声明设为 `{ defaultEffect: 'allow' }`。用户覆盖优先于角色，角色按 rank 从高到低决策，最后才使用节点默认值；exact 规则优先于最长 `prefix.*`。

用户可发送 `/account` 查看统一身份，发送 `/link` 生成 5 分钟有效的一次性关联码，再到另一个平台发送 `/link <code>` 合并身份、角色和 grants。

插件 UI 使用模块相对声明：

```ts
const pluginUi = ui(import.meta.url, './ui/index.tsx')
```

路径到绝对文件名的转换由 Pluxel authoring API 负责，平台插件不再重复 `fileURLToPath(new URL(...))`。

## 增加业务插件

命令型能力依赖 `ChatCommandsPlugin` 并在 `init()` 注册：

```ts
@Plugin({ name: 'WeatherPlugin' })
export class WeatherPlugin extends BasePlugin {
	constructor(private readonly commands: ChatCommandsPlugin) {
		super()
	}

	override init() {
		const dispose = this.commands.register({
			name: 'weather',
			description: '查询天气',
			permission: false,
			execute: async ({ args }) => lookupWeather(args.join(' ')),
		})
		this.ctx.effects.defer(dispose)
	}
}
```

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

更多当前设计取舍见 [docs/DESIGN.md](docs/DESIGN.md)。

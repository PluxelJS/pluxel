# Chatbots for Pluxel

基于当前 Pluxel static runtime 重写的聊天机器人插件集群。旧仓库只作为需求样本，不作为兼容目标。

## 现在包含什么

- `ChatHubPlugin`：transport-neutral 消息路由、时间窗去重、会话内串行、跨会话并行、处理器隔离和停机 drain。
- `ChatHubPlugin`：富消息发送规划、严格/降级模式、旁路 observer 和运行指标。
- `ChatAccessPlugin`：跨平台统一用户、角色与分层权限；业务状态持久化，管理面只是投影。
- `ChatCommandsPlugin`：分层路由、alias、flags、中间件和默认拒绝的权限节点。
- `ChatBuiltinsPlugin`：`/ping`、`/help`、`/status`。
- `ChatSandboxPlugin`：无需平台凭据即可进行 HTTP 或管理界面端到端测试。
- `TelegramAdapterPlugin`：Telegram long polling adapter，带 Vault 管理面板。
- `KookAdapterPlugin`：KOOK gateway adapter、完整 v3 API client 和 Vault 管理面板。

## 运行

```bash
pnpm install
pnpm --filter @repo/project-chatbots start
```

默认地址为 `http://127.0.0.1:3314`，直接打开即为 Pluxel 管理界面。adapter 始终运行以提供配置页面；未配置时保持 `unconfigured`，不会连接外部平台。`start` 与 `static` 都使用带 `staticRuntimeVitePlugin` 的 Vite host，插件源码不会绕过工具链直接执行。

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

Telegram API client 从 `@repo/chatbots-telegram/api` 导出。180 个 Bot API 方法与 `@gramio/types` 的 `APIMethods` 对齐：参数和返回值直接使用 GramIO 的 Bot API 10.1 类型，`Blob` 输入会自动编码为 `attach://` multipart。`api:generate/api:check` 使用 TypeScript compiler API 从外部声明同步完整方法集合及 `TelegramUpdate` 事件字段，macro 再于构建期内联两个 inventory。Bot 的原生方法只在共享 prototype 安装一次。

## 启用 KOOK

打开 Pluxel 中的 `KOOK Bot` 设置页，为每个账号填写稳定 Bot ID、Token 和可选 API Base。插件会为每个 Vault 配置创建独立 `KookBot`，调用 `user/me` 后分别建立 gateway。设置页支持多账号选择、鉴权测试、重连、断开及删除；群聊 conversation id 为 `channel:<channelId>`，私聊为 `direct:<userId>`。

完整 KOOK OpenAPI client 从 `@repo/chatbots-kook/api` 导出。84 个 v3 endpoints 由 `endpoints.txt` 在构建期通过 macro 内联；`api:check` 会双向比较 inventory 与 `KookAutoApi`，避免只有数量相同的假同步。独立 client 保留低层 API，注入业务插件的 `KookBot` 则只在顶层暴露原生具名方法，raw、频道/私聊 conversation、上传、回复、编辑、跟踪和临时消息工具统一位于 `bot.$`。

## 源码组织

公共 `index.ts` 只做 barrel export，不承载实现。跨平台协议按 `content/message/transport` 拆分；Hub 按 `handler/delivery/router/plugin` 拆分；命令按 `types/parser/registry/middleware/plugin` 拆分；平台 adapter 的 `protocol/codec/api/events` 与 Pluxel lifecycle plugin 分离。这样协议转换和规划可单测，只有 plugin 文件接触 Context、Vault 和 Web Management。Telegram 与 KOOK 只共享纯退避策略和 superseding abort lease，各自保留适合 long polling、WebSocket 的连接状态机。

新平台适配器必须遵循 [平台适配器设计规范](docs/PLATFORM_ADAPTERS.md)：平台插件公开只读 Bot registry，Bot 本身优先暴露原生 API，本项目增加的 raw、conversation 和生命周期能力统一收纳到 `$`。该文档同时说明如何从外部类型包或 OpenAPI 显式 codegen 出类型与 endpoint inventory，再通过 Pluxel macro 内联 metadata，并用共享 prototype 让所有 Bot 以最低实例成本获得具名 API 方法。

## 内容与匹配

`chat` builder 负责相邻文本合并、JSON 安全序列化和显式多消息意图：

```ts
return chat.batch(chat.of('任务 ', chat.link(url, '详情')), chat.image(previewUrl, '预览'))
```

`chat.batch()` 是 fail-fast；`chat.batchBestEffort()` 会继续发送后续条目，并在 `ChatSendResult.failures` 中返回失败索引。平台因能力不足产生的单消息拆分仍由 Hub planner 负责，两种语义不会混淆。

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

更多设计取舍见 [docs/DESIGN.md](docs/DESIGN.md)，旧项目迁移映射见 [docs/MIGRATION.md](docs/MIGRATION.md)。

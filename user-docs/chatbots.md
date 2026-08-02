# Chatbots 项目

`projects/chatbots` 是固定 catalog 的聊天机器人宿主，同时提供跨平台业务层和 Telegram、KOOK、Discord 原生平台能力。

## 选择依赖

- 跨平台命令依赖 `ChatCommandsPlugin`，把 `@pluxel/commands` 定义绑定为消息 route，并让返回的 registration 由当前插件 effects 持有。
- 跨平台非命令处理依赖 `ChatHubPlugin`，消费 JSON-safe `ChatMessage`。
- 平台专属事件或 API 直接依赖 `TelegramPlugin`、`KookPlugin` 或 `DiscordPlugin`，从只读 `bots` registry 取得账号。
- 只有需要把该平台接入跨平台消息管线时，宿主才安装 `TelegramHubBridgePlugin` 或 `KookHubBridgePlugin`；平台专属插件不依赖 bridge 或 Hub。
- 不把平台 SDK 对象、session 或发送方法写入 `ChatMessage.metadata`。

```ts
const bot = telegram.bots.require('notifications')
await bot.sendMessage({ chat_id: target, text: 'hello' })

bot.events.callback_query.on(async (query, signal) => {
	await bot.$.raw.call('answerCallbackQuery', { callback_query_id: query.id }, { signal })
})
```

Bot 顶层是平台原生 API；raw、conversation helper、状态和生命周期只存在于 `bot.$`。

## KOOK 绑定发送句柄

连续向相同频道和用户发送消息时，创建一个绑定句柄，把稳定目标、消息类型、模板和可见性设为默认值。
句柄不保存消息 ID，因此可安全用于单进程或集群；消息引用由业务的 memory、Redis 或数据库状态槽持有：

```ts
import { MessageType } from '@repo/chatbots-kook'

bot.events.group_message.on(async (event, signal) => {
	const progress = bot.$.channel(event.target_id, {
		type: MessageType.kmarkdown,
		template_id: 'job-progress',
		temp_target_id: event.author_id,
	}).withSignal(signal)

	const writeProgress = (content: string) =>
		messageRefs.update(`job:${jobId}:progress`, async (msg_id) => {
			const result = await progress.sendOrEdit({ msg_id, content, quote: event.msg_id })
			if ('message' in result) throw new Error(result.message)
			return result.data
		})

	await writeProgress('任务已开始')
	await writeProgress('任务进度：50%')
	await writeProgress('任务已完成')
})
```

`messageRefs.update(key, callback)` 表示由业务提供的“按逻辑 key 串行更新消息引用”能力：单进程可以使用
按 key 排队的内存 Map，集群则使用 Redis 锁/脚本或数据库事务。两种部署运行完全相同的 callback；KOOK 核心不
假装提供分布式锁。`sendOrEdit()` 在 `msg_id` 缺省时发送，存在时编辑，并始终返回当前 `msg_id`；编辑失败会原样
返回错误，不会静默补发重复消息。

目标和默认参数在创建时复制并冻结；单次 `send()`、`reply()` 和 `sendOrEdit()` 仍可覆盖字段。
私聊使用 `bot.$.direct({ target_id: userId }, defaults)`，拥有相同的显式条件写入契约。

`temp_target_id` 是 KOOK 的频道临时消息：消息只对指定用户可见。需要延迟删除时，在发送成功后把 `msg_id`
交给业务已有的 scheduler；核心不使用进程内 timer 冒充可恢复任务。事件 listener 或命令中的网络调用应通过
`withSignal(signal)` 组合调用方生命周期；句柄本身始终随 Bot 销毁而取消。

## Discord 原生 slash 命令

`DiscordPlugin` 拥有 Gateway、Vault Bot registry、消息组件和 application command 同步，但不依赖 ChatHub。
业务插件通过 `discord.commands.bind(command, projection)` 复用已有 `@pluxel/commands` 定义；projection 只映射
root/subcommand、Discord options、candidate、请求 context 与 terminal response。多个 subcommand 会合并为同一
root command。同步按 Bot 严格串行，并持久记录 carrier 管理过的 root；目录变化或进程重启后会撤销陈旧 root，
但不删除 application 的其他命令。

binding 从调用方 Context 取得 owner；消费插件停止时会撤销 route、取消并 drain 在途 interaction。需要业务
capability 的 Command 必须显式提供 `context(source)`，不得在 Discord adapter 复制 schema 或 handler，也不得把
原生 slash interaction 伪装为 `ChatMessage`。

组件按钮通过 `discord.interactions.on(customIdPrefix, handler)` 注册。它按最长 prefix 路由，并从 caller
Context 自动取得 owner；插件停止会撤销 route、组合取消 signal 并 drain 已开始的 handler，无需手动把 disposer
塞入 effects。

## KOOK 实用 Card

`renderKookCard()` 覆盖最常见的展示卡 + 交互操作组，不要求业务手写完整 Card JSON。内容卡默认使用
`secondary` 与 `lg`；只要提供 action，按钮就会自动放进第二张 `invisible` 卡，使内容与操作区保持整洁：

```ts
import { MessageType, renderKookCard } from '@repo/chatbots-kook'

const content = renderKookCard({
	title: '你的音乐控制面板已准备就绪',
	description: '点击下方按钮或复制链接到浏览器开始音乐体验',
	sections: [`> ${url}`],
	color: '#9826d3',
	context: {
		iconUrl: brandIconUrl,
		text: '使用 [Blaze.FM](https://www.kookapp.cn/app/invite/Q3cl1q) 一起听歌',
		textType: 'kmarkdown',
	},
	actions: [{ type: 'link', label: '进入控制面板', url }],
	actionContext: { iconUrl: privateIconUrl, text: '此条消息仅你可见' },
})

const panel = bot.$.channel(event.target_id, {
	type: MessageType.card,
	temp_target_id: event.author_id,
}).withSignal(signal)

await panel.send(content)
```

action 支持 `{ type: 'link', url }` 和 `{ type: 'return-val', value }`，默认按钮主题为 `secondary`；超过四个
action 时会保持顺序并自动换行成多个操作组。`actionContext` 只负责视觉提示；真正的单用户可见性仍必须通过发送参数
`temp_target_id` 建立。

需要完整 Card 能力时，使用同一入口导出的 `Card.Message` wire 类型和 `renderKookCardMessage()`：

```ts
import { MessageType, renderKookCardMessage, type Card } from '@repo/chatbots-kook'

const message = [
	{
		type: 'card',
		theme: 'none',
		modules: [
			{ type: 'header', text: '活动即将开始' },
			{ type: 'divider' },
			{
				type: 'section',
				text: {
					type: 'paragraph',
					cols: 2,
					fields: ['频道', channelName, '主持人', hostName],
				},
			},
			{
				type: 'container',
				elements: [{ type: 'image', src: coverUrl, fallbackUrl }],
			},
			{
				type: 'countdown',
				mode: 'second',
				startTime: Date.now() + 1_000,
				endTime: startsAt,
			},
		],
	},
] satisfies Card.Message

await bot.$.channel(channelId, { type: MessageType.card }).send(renderKookCardMessage(message))
```

全量类型覆盖 header、section/paragraph/accessory、image-group、container、action-group、context、divider、
file/audio/video、countdown 和 invite。类型会阻止 invisible card 使用不兼容 module、按钮放在 section 左侧、
link button 缺少 value、非 second countdown 携带 startTime 等非法组合；序列化时还会检查最多 5 张 card、
总计 50 个 module，以及图片组、context、action-group、文本长度、URL、颜色和未来时间戳等动态限制。
`renderKookCard()` 本身只生成这套全量类型并调用同一个序列化器，因此简写和全量不会形成两套协议。

## 跨平台命令

命令的结构化输入、输出和行为只定义一次；消息 route、alias、positionals、flags、权限和回复格式放在 Chat carrier binding：

```ts
import { defineCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'

const lookup = defineCommand({
	name: 'weather.lookup',
	description: '查询天气',
	behavior: { kind: 'query', world: 'open' },
	input: obj({ city: Type.String() }),
	output: obj({ forecast: Type.String() }),
	execute: async ({ city }) => ({ forecast: await weather.lookup(city) }),
})

override init() {
	this.ctx.effects.own(
		this.commands.register(lookup, {
			routes: ['weather', 'forecast'],
			positionals: ['city'],
			permission: false,
			respond: ({ forecast }) => forecast,
		}),
	)
}
```

公开命令必须显式设置 `permission: false`；否则默认声明 deny 的 `cmd.<command.name>`。匹配成功后 carrier 构造包含 `message`、`user`、`signal`、`reply` 和 `send` 的 `ChatCommandContext`。只要求基础 `CommandContext` 的命令还能复用到 runtime、CLI、KOOK 或 Agent；要求 Chat 上下文的命令不能进入基础 runtime catalog。未知 route 会继续 Hub handler 管线，已匹配但参数错误的 route 会回复安全错误并停止管线。

## KOOK 命令

KOOK carrier 用方法名区分两种真实语义。KOOK 原生命令用 `defineKookCommand()` 定义，handler 直接读取
`bot`、`event`、`signal` 并调用 `reply()`；它没有 output，也不需要 response marker：

```ts
import { defineKookCommand } from '@repo/chatbots-kook'

const inspect = defineKookCommand({
	name: 'kook.inspect',
	description: 'Inspect the invoking KOOK message.',
	behavior: { kind: 'query', world: 'closed' },
	input: obj({ detail: Type.String() }),
	async execute({ detail }, ctx) {
		await ctx.reply(`${ctx.bot.id}:${ctx.event.author_id}:${detail}`)
	},
})

override init() {
	this.kook.commands.register(inspect, {
		routes: ['inspect'],
		positionals: ['detail'],
	})
}
```

KOOK command prefix 由 `KookPlugin.prefix` 统一配置，省略时为 `/`，并限制为 1–16 个不含空白的字符。
依赖 KOOK 的插件不在 command binding 重复声明 prefix；需要生成帮助或操作提示时读取
`this.kook.commandPrefix`，确保展示的语法与 carrier 实际接受的语法一致。

需要复用到 runtime、CLI 或其他 carrier 的普通 `Command` 保持基础 context 和结构化 output，通过 `bind()`
补上 KOOK 语法与必需的终端回复：

```ts
this.kook.commands.bind(lookup, {
	routes: ['weather', 'forecast'],
	positionals: ['city'],
	respond: async ({ forecast }, ctx) => {
		await ctx.reply(forecast)
	},
})
```

`register()` 与 `bind()` 都自动归属于调用 `KookPlugin` 的消费插件，无需 `effects.own()`。手动 dispose 只撤销
route，不取消已经开始的调用；消费插件或 KOOK provider 停止时会拒绝新调用、abort 并 drain 在途调用。额外的
网络 IO 必须传递 `ctx.signal`；`ctx.reply()` 已自动传播该 signal。匹配的 KOOK route 会在 Hub bridge 前消费 event。

平台插件的 `upsertBot()` 返回已安装的受管 Bot，`reconnectBot()/disconnectBot()` 返回平台状态，`removeBot()` 不返回管理 DTO。管理 RPC 只服务配置页面，不是业务插件 API。

Telegram/KOOK 平台插件 required-depend `WretchPlugin`，所有 HTTP API 请求使用 caller-bound 原生 Wretch base，自动继承宿主的 timeout、并发、等待队列、origin policy 和 lifecycle cancellation。Telegram `retry_after` 或 KOOK HTTP `Retry-After` 仍由每个 Bot 的平台 gate 处理，只延迟后续请求，不重放当前失败调用。

## 顺序、背压与重试

Hub 按 `(platform, accountId, conversationId)` 串行处理入站消息和逻辑出站发送。一个 batch 或富消息拆分完成后，才会开始同一会话的下一次发送；不同会话仍然并行。

handler 和 observer 必须监听并传递 `context.signal`。Hub 不会在超时后强行放行同一会话，因为 JavaScript 无法终止仍在运行的 Promise，强行继续会让旧副作用与新消息并发。对外部请求设置自身 timeout，并使用传入的 signal 取消底层调用。

入站、出站队列同时有每会话和全局固定上限。队列满时调用会拒绝，不会通过制造大量 conversation 绕过背压；调用方应记录错误并让平台接入层重试，不能用无界本地数组吸收压力。`hub.snapshot()` 提供当前队列深度、handler/observer 失败、逻辑消息发送失败、拒绝和停机 drain timeout 计数；生命周期取消不会污染失败指标。

Hub 的时间窗去重只在当前进程内有效。并发重复消息会共享第一次 dispatch 的结果；失败或取消不会提交去重记录，因此平台可以重试。平台会在事件投递完成后推进 Telegram offset 或 KOOK SN，但进程崩溃仍可能造成重放。会产生支付、发券、写外部系统等副作用的处理器必须保存业务幂等记录：

```ts
import { messageKey } from '@repo/chatbots-contracts'

const idempotencyKey = messageKey(context.message)
if (await store.has(idempotencyKey)) return 'stop'
await performSideEffect()
await store.put(idempotencyKey)
```

这提供可审计的 at-least-once 处理方式；不要假设跨平台 exactly-once。

## 管理和持久状态

平台 token 只保存在 Vault。Bot registry 与连接状态是运行时事实；Workbench 订阅时立即取得完整、有界的安全 snapshot，之后只接收有意义的状态变化，不把 polling/gateway 状态复制到 PostgreSQL。用户、角色和 grant 仍属于 Access 持久业务状态。Workbench 使用多账号方法 `upsertBot/removeBot/testBot/reconnectBot/disconnectBot`，账号 ID 是稳定的本地 ID，不是远端 Bot ID。

插件详情 Tab 只提供在线/异常/已配置数量、少量账号状态和“添加 Bot / 打开管理台”快捷入口。Workbench 的一级导航只显示一个 `Bots` 入口；Telegram、KOOK、Sandbox 通过相同 navigation group 自主注册二级页面，未安装的平台不会出现，新增平台也不需要修改中央列表。每个平台的管理首页使用全宽账号卡片和搜索；点击账号或“添加 Bot”会打开 Workbench 原生 Tab，因此账号详情参与统一 Tab 切换、关闭和恢复，不占用常驻侧栏。管理能力包括创建、更换凭据、测试鉴权、重连、断开和删除。Telegram 详情保留 Polling offset、最近 poll/update、连续失败和退避；KOOK 详情保留 Gateway phase、SN、事件、恢复、Ping/Pong、乱序、重复、缓冲与溢出指标。删除会先要求确认，页面会明确显示状态流连接与操作错误。

通用 `ChatMessage` 的媒体 `url` 必须是目标 transport 可用的跨平台资源地址。Telegram `file_id` 只对特定 Bot 账号有意义，因此不会伪装成通用 URL；bridge 会生成可读附件占位，并把 JSON-safe 文件标识放在 `metadata.telegramAttachments`。需要真正读取或复用 Telegram 文件时，直接依赖 `TelegramPlugin` 消费原生 update。

同一账号的保存、删除、重连和断开按调用顺序执行；不同账号可以并行。调用方不需要额外使用前端锁保证 Vault 与运行时 Bot 一致。

宿主负责提供 React/Mantine/Pluxel runtime、Wretch capability 和 catalog 中的插件实例；平台包自身不依赖 ChatHub/contracts。这样只使用原生 Telegram 或 KOOK API 的产品不会被迫安装跨平台消息层。

完整运行、配置和扩展示例见 [`projects/chatbots/README.md`](../projects/chatbots/README.md)。

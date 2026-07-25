# Chatbots 项目

`projects/chatbots` 是固定 catalog 的聊天机器人宿主，同时提供跨平台业务层和 Telegram、KOOK 原生平台能力。

## 选择依赖

- 跨平台命令依赖 `ChatCommandsPlugin`，在 `init()` 中注册命令。
- 跨平台非命令处理依赖 `ChatHubPlugin`，消费 JSON-safe `ChatMessage`。
- 平台专属事件或 API 直接依赖 `TelegramPlugin` 或 `KookPlugin`，从只读 `bots` registry 取得账号。
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

平台插件的 `upsertBot()` 返回已安装的受管 Bot，`reconnectBot()/disconnectBot()` 返回平台状态，`removeBot()` 不返回管理 DTO。管理 RPC 只服务配置页面，不是业务插件 API。

平台插件 required-depend `WretchPlugin`，所有 API 请求使用 caller-bound 原生 Wretch base，自动继承宿主的 timeout、并发、等待队列、origin policy 和 lifecycle cancellation。Telegram `retry_after` 或 KOOK HTTP `Retry-After` 仍由每个 Bot 的平台 gate 处理，只延迟后续请求，不重放当前失败调用。

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

插件详情 Tab 只提供在线/异常/已配置数量、少量账号状态和“添加 Bot / 打开管理台”快捷入口。Workbench 的一级导航只显示一个 `Bots` 入口；Telegram、KOOK、Sandbox 通过相同 navigation group 自主注册二级页面，未安装的平台不会出现，新增平台也不需要修改中央列表。完整管理台采用可拖拽并记住尺寸的账号/详情分栏，可搜索、创建、更换凭据、测试鉴权、重连、断开和删除。Telegram 详情保留 Polling offset、最近 poll/update、连续失败和退避；KOOK 详情保留 Gateway phase、SN、事件、恢复、Ping/Pong、乱序、重复、缓冲与溢出指标。删除会先要求确认，页面会明确显示状态流连接与操作错误。

通用 `ChatMessage` 的媒体 `url` 必须是目标 transport 可用的跨平台资源地址。Telegram `file_id` 只对特定 Bot 账号有意义，因此不会伪装成通用 URL；bridge 会生成可读附件占位，并把 JSON-safe 文件标识放在 `metadata.telegramAttachments`。需要真正读取或复用 Telegram 文件时，直接依赖 `TelegramPlugin` 消费原生 update。

同一账号的保存、删除、重连和断开按调用顺序执行；不同账号可以并行。调用方不需要额外使用前端锁保证 Vault 与运行时 Bot 一致。

宿主负责提供 React/Mantine/Pluxel runtime、Wretch capability 和 catalog 中的插件实例；平台包自身不依赖 ChatHub/contracts。这样只使用原生 Telegram 或 KOOK API 的产品不会被迫安装跨平台消息层。

完整运行、配置和扩展示例见 [`projects/chatbots/README.md`](../projects/chatbots/README.md)。

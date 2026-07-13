# Chatbots 项目

`projects/chatbots` 是固定 catalog 的聊天机器人宿主，同时提供跨平台业务层和 Telegram、KOOK 原生平台能力。

## 选择依赖

- 跨平台命令依赖 `ChatCommandsPlugin`，在 `init()` 中注册命令。
- 跨平台非命令处理依赖 `ChatHubPlugin`，消费 JSON-safe `ChatMessage`。
- 平台专属事件或 API 直接依赖 `TelegramPlugin` 或 `KookPlugin`，从只读 `bots` registry 取得账号。
- 不把平台 SDK 对象、session 或发送方法写入 `ChatMessage.metadata`。

```ts
const bot = telegram.bots.require('notifications')
await bot.sendMessage({ chat_id: target, text: 'hello' })

bot.events.callback_query.on(async (query, signal) => {
	await bot.$.raw.call('answerCallbackQuery', { callback_query_id: query.id }, { signal })
})
```

Bot 顶层是平台原生 API；raw、conversation helper、状态和生命周期只存在于 `bot.$`。

## 顺序、背压与重试

Hub 按 `(platform, accountId, conversationId)` 串行处理入站消息和逻辑出站发送。一个 batch 或富消息拆分完成后，才会开始同一会话的下一次发送；不同会话仍然并行。

每个会话的入站、出站队列都有固定上限。队列满时调用会拒绝，不会无限累积内存；调用方应记录错误并让平台接入层重试，不能用无界本地数组吸收压力。`hub.snapshot()` 提供当前队列深度、发送失败、拒绝和停机 drain timeout 计数。

Hub 的时间窗去重只在当前进程内有效。平台会在事件投递完成后推进 Telegram offset 或 KOOK SN，但进程崩溃仍可能造成重放。会产生支付、发券、写外部系统等副作用的处理器必须保存业务幂等记录：

```ts
import { messageKey } from '@repo/chatbots-contracts'

const idempotencyKey = messageKey(context.message)
if (await store.has(idempotencyKey)) return 'stop'
await performSideEffect()
await store.put(idempotencyKey)
```

这提供可审计的 at-least-once 处理方式；不要假设跨平台 exactly-once。

## 管理和持久状态

平台 token 只保存在 Vault。Bot registry、连接状态和管理 SignalDB 是运行时投影；用户、角色和 grant 属于 Access 业务状态，即使关闭 Web Management 仍然有效。管理面使用多账号方法 `upsertBot/removeBot/testBot/reconnectBot/disconnectBot`，账号 ID 是稳定的本地 ID，不是远端 Bot ID。

完整运行、配置和扩展示例见 [`projects/chatbots/README.md`](../projects/chatbots/README.md)。

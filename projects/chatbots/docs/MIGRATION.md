# 从旧 chatbots 迁移

新版不是逐文件搬运。建议按行为迁移，并在 sandbox 中先固定输入输出。

| 旧概念                                | 新位置                                | 处理                                                   |
| ------------------------------------- | ------------------------------------- | ------------------------------------------------------ |
| `bot-core` events/listen/adapter      | `contracts` + `hub`                   | 合并为小型稳定边界和 handler pipeline                  |
| `AnyMessage` 上的 `reply/send*`       | `ChatHandlerContext.reply()`          | 数据与行为分离                                         |
| `Part`/renderer/outbound planner      | `ChatBlock` + Hub planner             | 保留可预测规划；数据仍为 JSON-safe                     |
| `mc.batch` / `batchBestEffort`        | `chat.batch*`                         | 保留显式多消息与失败策略，不承诺平台回滚               |
| listen matcher / Aho-Corasick         | `hub.registerMatcher()`               | 保留 claim/observe 和共享 automaton，移除 Context 耦合 |
| `bot-suite` command wrapper           | `commands` + `access`                 | 路由与身份/权限分层，不再组成大 facade                 |
| `bot-suite` users/permissions         | `access`                              | 独立持久状态域，管理面只做投影                         |
| `bot-suite` sandbox + SSE             | `sandbox` HTTP + typed RPC            | CI 直接请求，人工调试使用管理页面                      |
| platform 内聚合式 manager             | plugin + registry/bot/management 分层 | 保留多 Bot 能力，拆开持久化、管理投影和单 Bot 生命周期 |
| KOOK 多 Bot manager                   | `KookAdapterPlugin.bots`              | 迁移为只读 registry，Bot 直接公开原生 API              |
| permission trie / roles / identity DB | `access`                              | 保留 exact/wildcard/role 语义，简化为 Map 热路径       |
| platform raw events / SDK extensions  | 对应 Bot / adapter plugin             | `bot.events` + `bot.method()`，不污染 Hub              |

平台 adapter 的公共面不再是 `requireApi()`。通过 `platform.bots.require(localId)` 获得 Bot，
并直接调用 `bot.sendMessage()` 等原生 API；raw、
conversation helper 和生命周期位于 `bot.$`。完整规范及 codegen/macro 模式见
[PLATFORM_ADAPTERS.md](PLATFORM_ADAPTERS.md)。

迁移一个旧业务插件时：

1. 提取它实际消费的文本、actor、conversation 和附件字段。
2. 用 sandbox 请求写一个行为测试样例。
3. 命令型逻辑注册到 `ChatCommandsPlugin`；观察型逻辑注册到 `ChatHubPlugin`。
4. 通过 handler context 回复，不保存 adapter/session 对象。
5. 注册产生的 disposer、timer、client 都交给 `ctx.effects`。
6. 只有稳定通过 sandbox 后，再用 Telegram、KOOK 或新 adapter 做平台验证。
7. 只在单个平台成立的功能直接依赖该 adapter；不要先扩张 `ChatMessage` 或 Hub API。

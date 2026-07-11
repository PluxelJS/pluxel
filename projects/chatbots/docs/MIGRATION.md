# 从旧 chatbots 迁移

新版不是逐文件搬运。建议按行为迁移，并在 sandbox 中先固定输入输出。

| 旧概念                                   | 新位置                         | 处理                                        |
| ---------------------------------------- | ------------------------------ | ------------------------------------------- |
| `bot-core` events/listen/adapter         | `contracts` + `hub`            | 合并为小型稳定边界和 handler pipeline       |
| `AnyMessage` 上的 `reply/send*`          | `ChatHandlerContext.reply()`   | 数据与行为分离                              |
| `Part`/renderer/outbound planner         | `ChatBlock` + adapter `send()` | 删除全局智能规划；平台负责可预期降级        |
| `bot-suite` command wrapper              | `commands`                     | 不再绑定用户、权限、MCP 和 UI               |
| `bot-suite` sandbox + SSE                | `sandbox` HTTP                 | 一个请求直接返回本轮 replies，CI 更容易使用 |
| platform 内重复 manager/registry/RPC/SSE | adapter + Pluxel lifecycle     | 删除重复控制面                              |
| KOOK 多 Bot manager                      | `KookAdapterPlugin`            | 第一版单 Bot；未来使用 Pluxel fork/config   |
| permission trie / roles / identity DB    | 暂不迁移                       | 等产品授权边界确定后做独立插件              |

迁移一个旧业务插件时：

1. 提取它实际消费的文本、actor、conversation 和附件字段。
2. 用 sandbox 请求写一个行为测试样例。
3. 命令型逻辑注册到 `ChatCommandsPlugin`；观察型逻辑注册到 `ChatHubPlugin`。
4. 通过 handler context 回复，不保存 adapter/session 对象。
5. 注册产生的 disposer、timer、client 都交给 `ctx.effects`。
6. 只有稳定通过 sandbox 后，再用 Telegram、KOOK 或新 adapter 做平台验证。

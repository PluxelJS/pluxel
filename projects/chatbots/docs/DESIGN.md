# 新版 Chatbots 设计

## 目标

新版覆盖可靠平台接入、稳定富消息协议、可组合业务处理、统一身份授权和低成本本地验证。公共协议保持 JSON-safe，平台差异停留在 adapter 边界。

平台适配器的规范性作者模型、Bot registry、原生 API 分层及 codegen/macro 流水线见
[PLATFORM_ADAPTERS.md](PLATFORM_ADAPTERS.md)。Telegram、KOOK 已按该公共模型提供多账号
Bot；新适配器不得以兼容性的 `requireApi()` 代替该规范。

```text
Telegram / KOOK adapters         Sandbox HTTP
             \                   /
              ChatHubPlugin
              - dedupe
              - per-chat ordering
              - handler / observer pipeline
              - outbound planning
                 /            \
       ChatCommandsPlugin    ordinary handlers
              |
       ChatAccessPlugin
               |
       ChatBuiltinsPlugin / product plugins

Pluxel management UI -> typed RPC -> Vault + adapter lifecycle
```

## 包边界

| 包          | 责任                                                           | 不负责                 |
| ----------- | -------------------------------------------------------------- | ---------------------- |
| `contracts` | JSON-safe 富消息、内容块、transport 契约                       | 路由、状态、平台 API   |
| `hub`       | transport/handler/observer、调度、发送规划和指标               | 命令、权限、用户数据库 |
| `access`    | 统一用户、角色、grant 与持久化                                 | 平台连接、命令解析     |
| `commands`  | 分层路由、flags、中间件与权限接缝                              | 消息接入、角色存储     |
| `sandbox`   | 可重复的端到端输入输出与历史                                   | 伪装具体平台全部语义   |
| `telegram`  | GramIO 类型 API、Bot registry、polling、原始 update 与双向转换 | 跨平台业务规则         |
| `kook`      | KOOK API、Bot registry、原始 event、gateway 心跳重连与转换     | 跨平台业务规则         |
| `builtins`  | 最小运维命令                                                   | 框架级默认策略         |

## 关键约束

1. `ChatMessage` 必须可序列化。旧设计把方法、原始 session 和平台行为塞进消息对象，导致测试、持久化和跨进程传递困难。新版回复通过 handler context 完成。
2. handler 是可短路的有序管线，observer 是不参与认领的旁路；二者错误都隔离到单个注册项。
3. 同一 `(platform, accountId, conversation)` 严格串行，防止命令和状态更新乱序；不同账号或会话不互相阻塞。handler/observer 执行计划只在注册表变化时重建，消息热路径不重复排序和分配注册表快照。
4. 注册返回幂等清理函数，并由消费插件挂到 `ctx.effects`。Hub 停止时先中止执行信号，再 drain 已进入的会话队列；HMR/停用不保留幽灵 handler 或悬空任务。
5. adapter 管理面常驻运行，token 只保存在 Pluxel Vault；未配置时状态为 `unconfigured`，不会注册 transport、SSE 或重连循环。
6. 插件依赖表达硬前置条件。commands 依赖 hub，builtins 依赖 commands；不使用全局 singleton 或 import-time registry。
7. 富消息先由 Hub 按 transport capability 做归一化，再决定 mixed、拆分或 `atomicBlocks` 平台原子布局。`mixedContent` 不会绕过 block 校验；`strict` 拒绝能力缺口，`best-effort` 才把不支持的媒体降级成可读文本。
8. 身份和授权属于持久业务状态；SignalDB 只做可选管理投影，headless host 中授权逻辑保持完整。
9. `index.ts` 只定义公共出口。纯 model/codec/planner 不依赖 Pluxel Context，连接状态机和管理投影只在 plugin 层组合。
10. 可审阅的静态平台清单使用 macro 在构建期内联。macro 负责消除运行时文件读取和重复方法分配，不隐藏动态业务决策。
11. 显式 batch 与平台自动拆分是两层语义：batch 表达调用方希望发送多条消息，planner 只处理单条逻辑消息如何适配平台能力。
12. 固定关键词匹配使用延迟编译的 Aho-Corasick index；claim 有顺序和短路，observe 不参与所有权竞争。普通 handler 不承担批量 pattern 扫描。
13. adapter 共享纯 `ExponentialBackoff`、可取消 delay 与 superseding abort lease，但不共享连接基类。WebSocket、SSE 和 long polling 各自拥有状态机，新配置会先使旧鉴权/连接 generation 失效。
14. 每个平台 adapter 同时是可依赖的 Pluxel capability plugin：插件公开只读 Bot registry，Bot 顶层公开平台原生 API，`$` 收纳 raw/高级能力/生命周期，raw event 绑定产生它的 Bot。平台专属插件依赖 adapter；只有确实跨平台的业务才依赖 Hub。
15. Telegram Bot API 的方法参数、返回值和对象模型以 `@gramio/types` 为权威；本仓库只维护构建期 HTTP method inventory、传输实现和 ChatMessage codec。
16. 多账号路由显式区分 `platform` 与 `accountId`；不能把账号 ID 拼进 platform，也不能让单一 transport 名称在多个 Bot 之间产生歧义。
17. codegen 与 macro 分阶段：显式 codegen 生成并提交类型/inventory，macro 只把本地静态 metadata 内联到 bundle；正常构建不访问网络、不改写源码。
18. 平台插件不把 ChatHub 声明成 required constructor dependency；通过 `plugins.use()` 动态投影。Hub 缺席或 HMR 替换不影响 Bot 原生 API 和平台事件连接。
19. `bot.$.status` 是连接状态机拥有的冻结平台快照；Telegram polling 与 KOOK gateway 分别记录有界计数、最近时间点、offset/SN 和退避状态。管理 SignalDB 只投影有意义变化，不是运行状态源，heartbeat 与空 poll 不制造固定周期持久化写。
20. 有序 gateway 的所有 frame 进入同一异步 tail，且 reconnect 必须等待该 tail 收敛后再读取 checkpoint。事件 handler 完成后才推进连续 SN；重复帧丢弃，乱序帧使用有界 buffer。HELLO 与 resume ACK 都有明确 timeout；普通断线保留 session/SN 以 resume，握手超时、协议拒绝、明确 hard reconnect 或 buffer 无法收敛时清空恢复状态并回退全新连接。

## 从旧设计保留什么

- 保留声明文件与 build-time macro：平台 API 清单是可审阅的数据源，构建产物不在运行时读取文件。
- 保留原生具名 API、raw escape hatch 和平台高级工具三层语义，但统一表现为 `bot.method()` 与 `bot.$.*`，避免多个 `$xxx` namespace 漂移。
- 保留 normalize/adapter 边界和平台领域类型，不把 KOOK、Telegram 对象污染跨平台消息协议。
- 保留可组合的 conversation builder，但 builder 只存在于平台 SDK；`ChatMessage` 仍然是可序列化数据。
- 保留平台插件管理 Bot 集合的能力，但 registry、配置存储、管理投影和单 Bot 生命周期分层实现，避免恢复旧 manager 的职责堆积。

## 刻意不恢复的旧模式

- 不把平台 session、发送方法或二进制 Buffer 放进 `ChatMessage`；消息仍然可以持久化和跨进程传递。
- 不恢复把 registry、持久化、RPC、SSE/webhook 和 Bot 生命周期塞进一个 manager 的模式。一个平台插件可以管理多个 Bot，但各层必须保持独立。
- 不让 Hub 知道平台 SDK。KOOK/Telegram SDK 使用独立子入口，业务可按需依赖。
- 不把 Telegram/KOOK 原始事件塞入通用消息；平台插件公开静态可枚举的 `EvtChannel` 属性，并同时提供 Bot 局部与 Plugin 聚合事件面。
- 不恢复控制宿主布局的插件 API。沙箱、权限和 adapter 都只贡献自己的页面或 tab。

## 下一步扩展顺序

1. 用真实平台业务插件继续验证 Bot/event 与 handler/command 契约。
2. 加入 Telegram/KOOK webhook 模式与签名验证，适配无状态部署。
3. 为平台原生 rate limit header 增加每 Bot 调度策略，不把限流塞进 ChatHub。
4. 在兼容窗口结束后移除 `requireApi()`、旧单账号 RPC 和旧 Vault key 迁移代码。
5. 新平台按 `PLATFORM_ADAPTERS.md` 复用 registry/config/macro 原语，但保留自己的连接状态机。

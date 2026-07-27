# Chatbots 设计

## 目标

本项目覆盖可靠平台接入、稳定富消息协议、可组合业务处理、统一身份授权和低成本本地验证。公共协议保持 JSON-safe，平台差异停留在 adapter 边界。

平台适配器的规范性作者模型、Bot registry、原生 API 分层及 codegen/macro 流水线见
[PLATFORM_ADAPTERS.md](PLATFORM_ADAPTERS.md)。Telegram、KOOK 已按该公共模型提供多账号 Bot。

```text
TelegramPlugin / KookPlugin      Sandbox HTTP
        | optional bridge             |
        +------------------------------+
                       |
                  ChatHubPlugin
              - dedupe
              - bounded per-chat ingress/egress ordering
              - handler / observer pipeline
              - outbound planning
                 /            \
       ChatCommandsPlugin    ordinary handlers
              |
       ChatAccessPlugin
               |
       ChatBuiltinsPlugin / product plugins

Pluxel workbench UI -> typed RPC -> Vault + adapter lifecycle
```

## 包边界

| 包                    | 责任                                                                          | 不负责                 |
| --------------------- | ----------------------------------------------------------------------------- | ---------------------- |
| `contracts`           | JSON-safe 富消息、内容块、transport 契约                                      | 路由、状态、平台 API   |
| `platform-kit`        | Bot registry、账号存储、入站 consumer、串行/重试/取消原语、共享管理 UI        | Hub 路由、平台状态机   |
| `workbench-support`   | Access/Sandbox 的数据库管理投影与 wire schema                                 | 平台账号和连接状态     |
| `hub`                 | transport/handler/observer、调度、发送规划和指标                              | 命令、权限、用户数据库 |
| `access`              | 统一用户、角色、grant 与持久化                                                | 平台连接、命令解析     |
| `commands`            | 分层路由、flags、中间件与权限接缝                                             | 消息接入、角色存储     |
| `sandbox`             | 可重复的端到端输入输出与历史                                                  | 伪装具体平台全部语义   |
| `telegram`            | GramIO 类型 API、Bot registry、polling、原始 update、账号管理                 | ChatMessage 与 Hub     |
| `telegram-hub-bridge` | Telegram codec、确认型入站 consumer 与 transport                              | 账号和连接生命周期     |
| `kook`                | KOOK API、Bot registry、原始 event、typed command carrier、gateway 与账号管理 | ChatMessage 与 Hub     |
| `kook-hub-bridge`     | KOOK codec、确认型入站 consumer 与 transport                                  | 账号和连接生命周期     |
| `builtins`            | 最小运维命令                                                                  | 框架级默认策略         |

## 依赖声明

- 宿主拥有 `@pluxel/runtime`、`@pluxel/wretch`、React、Mantine 和 Tabler 等 singleton/shared UI 依赖，并显式安装 catalog 中的插件；平台插件通过 constructor 依赖 caller-bound Wretch capability，不自行持有全局 fetch、宿主并发队列或 HTTP 生命周期。
- constructor 中的 required plugin capability 同样是 peer，由宿主选择并保证唯一实例；纯源码实现库如 `contracts`、`platform-kit` 仍是普通 dependency。
- 平台包不得声明 `contracts` 或 `hub`。只有 `{platform}-hub-bridge` 桥接包声明这条依赖边，因而 Telegram/KOOK capability 可被平台专属插件单独使用。
- 平台管理 UI 与 Vault 账号生命周期仍由平台插件拥有；`ctx.workbench.mount()` 返回 `undefined` 时不会初始化管理状态或 UI。它们不另拆成常驻对接包。
- `test/package-boundaries.test.ts` 固化上述边界，避免后续 import 或 manifest 修改重新引入反向依赖。
- `projects/chatbots/packages/*` 放无插件实例身份的共享源码，`platforms/*` 放外部平台 capability
  与其可选 Hub bridge，`plugins/*` 只放产品/业务插件。三者当前都是 `@repo` 私有包。这里的
  “独立使用”指 workspace 内可单独装配，不宣称已经是可从 npm 安装的公共发行包。

## 关键约束

1. `ChatMessage` 必须可序列化，只包含数据；回复通过 handler context 完成，平台 session 和行为留在 adapter 边界。
2. handler 是可短路的有序管线，observer 是不参与认领的旁路；二者错误都隔离到单个注册项。
3. 同一 `(platform, accountId, conversation)` 的入站消息严格串行；同一地址的逻辑出站发送也严格串行，batch 与 planner 拆分不会被其他调用穿插。不同账号或会话不互相阻塞。handler/observer 执行计划只在注册表变化时重建。
4. 入站与出站队列同时有每会话和全局上限，满载时拒绝且不污染去重记录；注册返回幂等清理函数并挂到 `ctx.effects`。Hub 停止时先中止执行信号，再在固定 deadline 内 drain，忽略取消的 handler 不得无限阻塞插件生命周期。
5. token 只保存在 Pluxel Vault；没有账号记录时 Bot registry 为空，不会注册 transport 或启动连接循环。Workbench disabled 时不创建管理事件 producer；enabled 时订阅立刻收到完整、有界的账号 snapshot，后续只在有意义变化时重新发布。
6. 插件依赖表达硬前置条件。commands 依赖 hub，builtins 依赖 commands；不使用全局 singleton 或 import-time registry。
7. 富消息先由 Hub 按 transport capability 做归一化，再决定 mixed、拆分或 `atomicBlocks` 平台原子布局。`mixedContent` 不会绕过 block 校验；`strict` 拒绝能力缺口，`best-effort` 才把不支持的媒体降级成可读文本。
8. 身份和授权属于持久业务状态；Workbench `liveQuery` 只做可选 PostgreSQL-backed 管理投影，headless host 中授权逻辑保持完整。
9. `index.ts` 只定义公共出口。平台 `plugin.ts` 只组合 BotManager 与可选 Workbench；BotManager 拥有 Vault、registry、同账号串行变更和 Bot replacement；API client 只拥有原生 HTTP 协议。codec 只在桥接包组合。
10. 可审阅的静态平台清单使用 macro 在构建期内联。macro 负责消除运行时文件读取和重复方法分配，不隐藏动态业务决策。
11. 显式 batch 与平台自动拆分是两层语义：batch 表达调用方希望发送多条消息，planner 只处理单条逻辑消息如何适配平台能力。
12. Hub 只提供 transport、handler 和 observer 等实际调用点；未被产品使用的 matcher/index 等扩展不得提前进入公共 API。
13. adapter 只从 `platform-kit` 的明确子入口共享 registry、账号存储、串行器、retry gate、纯 `ExponentialBackoff`、可取消 delay 与 superseding abort lease，不通过 Hub 获取这些原语，也不共享连接基类。WebSocket、SSE 和 long polling 各自拥有状态机。
14. 每个平台 adapter 同时是可依赖的 Pluxel capability plugin：插件公开只读 Bot registry，Bot 顶层公开平台原生 API，`$` 收纳 raw/高级能力/生命周期，raw event 绑定产生它的 Bot。平台专属插件依赖 adapter；只有确实跨平台的业务才依赖 Hub。
15. Telegram Bot API 的方法参数、返回值和对象模型以 `@gramio/types` 为权威；平台包只维护构建期 HTTP method inventory 与 HTTP transport，ChatMessage codec 属于 `telegram-hub-bridge`。
16. 多账号路由显式区分 `platform` 与 `accountId`；不能把账号 ID 拼进 platform，也不能让单一 transport 名称在多个 Bot 之间产生歧义。
17. codegen 与 macro 分阶段：显式 codegen 生成并提交类型/inventory，macro 只把本地静态 metadata 内联到 bundle；正常构建不访问网络、不改写源码。
18. 平台插件不导入 ChatHub 或 contracts。独立 bridge plugin 通过 constructor 依赖平台 capability 与 Hub，并注册 checkpoint-critical 原生事件 consumer；不安装 bridge 时 Bot 原生 API 和平台事件连接完全独立运行。
19. `bot.$.status` 是连接状态机拥有的冻结平台快照；Telegram polling 与 KOOK gateway 分别记录有界计数、最近时间点、offset/SN 和退避状态。Workbench 通过 events 取得完整运行 snapshot，不把临时连接状态复制到数据库。
20. 有序 gateway 的所有 frame 进入同一异步 tail，且 reconnect 必须等待该 tail 收敛后再读取 checkpoint。事件 handler 完成后才推进连续 SN；重复帧丢弃，乱序帧使用有界 buffer。HELLO 与 resume ACK 都有明确 timeout；普通断线保留 session/SN 以 resume，握手超时、协议拒绝、明确 hard reconnect 或 buffer 无法收敛时清空恢复状态并回退全新连接。
21. Hub 去重是有界进程内优化：并发重复调用共享同一个 in-flight 结果，成功后提交时间窗记录，失败或取消后删除记录以允许重试。它不承诺 exactly-once。Telegram 在原始事件和所有入站 consumer 完成后推进 offset，KOOK 同样只在 consumer 完成后推进 SN；业务副作用使用 `messageKey()` 和业务持久化实现幂等。
22. Access 的业务状态使用原子 snapshot，连续变化只写最新待落盘版本；管理投影按受影响的 user/role 更新 PostgreSQL projection table，live query 不是业务状态源。
23. handler 与 observer 必须协作响应 `AbortSignal`。Hub 不通过 timeout race 放行同一会话的后续消息，因为无法终止的旧 Promise 仍可能产生副作用，那会破坏会话串行保证；队列上限负责背压，停机 deadline 只负责释放插件生命周期。
24. 每个 Bot 账号只对应一个 `accounts.<id>` Vault 记录，token 与 API base 原子读写；账号存储不维护字段级 key 或自己的并发队列。Hub 的失败指标在实际语义边界计数：best-effort 的局部失败可见，生命周期取消不冒充业务失败。
25. 平台 API 从 required `WretchPlugin` 取得 caller-bound native Wretch base，复用宿主 timeout、并发、队列、origin policy 和生命周期；每个 Bot 仍拥有独立平台 retry gate。Telegram `parameters.retry_after` 与 KOOK HTTP `Retry-After` 只延迟该 Bot 的后续请求，不自动重放当前请求。
26. adapter 以本地账号 ID 串行执行配置写入、Bot replacement、删除、重连和断开；不同账号保持并行。配置存储和运行时 registry 必须观察同一账号操作顺序，不能各自拥有互不协调的 mutation tail。
27. Access 持久化在进入 domain 前按当前 schema 严格校验。损坏、缺字段、重复身份或悬空 user/role 引用会让插件启动失败，不能猜测字段、丢弃记录或回退为空状态继续运行。
28. 包默认入口只导出稳定作者能力与必要类型。workbench RPC/DTO、Router、Gateway、codec、parser、registry 和状态解析器属于包内实现，测试使用相对路径，不通过公共 barrel 反向固化内部结构。
29. 平台插件的常驻能力不返回 workbench DTO，也不包含 UI 提示文本。账号配置返回受管 Bot，连接操作返回平台状态，删除返回 `void`；可选 Workbench RPC 和 snapshot event 自己映射安全 DTO 与管理文案。
30. 入站 consumer 按注册顺序 fail-fast，并在每个原生事件开始时冻结执行计划；dispatch 中的注册/注销只影响下一个事件。bridge 的 consumer 和 transport 都必须组合 bridge-owned abort signal，stop、rollback 与 HMR replacement 会先取消在途工作，再释放注册。
31. 通用媒体 block 的 `url` 只承载目标 transport 可消费的跨平台资源。账号本地文件句柄不得伪装成 URL；Telegram `file_id` 等原生引用留在 JSON-safe metadata 和原生事件面，通用内容使用可读占位。下载、重传或平台内复用由显式平台插件实现，不能偷偷扩张 Hub 协议。
32. 平台 Workbench route 通过共同的 `bots` navigation group 自主注册，宿主只聚合导航，不枚举平台或合并 owner/grant。管理首页使用全宽 launcher；账号详情和创建流程通过平台自己的参数化 route 打开 Workbench 原生 Tab，平台诊断仍由精确的 Telegram/KOOK renderer 拥有。
33. 通用 command 只依赖基础 `CommandContext`，可以同时进入 runtime catalog 与 typed carrier。跨平台消息命令按 schema 绑定到 `ChatCommandsPlugin` 的 argv router，由它构造 `ChatCommandContext`、授权并投影回复；KOOK 专属 command 显式要求 `KookCommandContext`，只进入 KOOK typed router。两者都复用 `Command`，不复制业务 registry 或执行实现。KOOK router 命中后在 Hub bridge 前消费该 event，未命中才继续普通 consumer。Workbench 不伪造平台 event context。

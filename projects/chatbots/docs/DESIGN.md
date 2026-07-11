# 新版 Chatbots 设计

## 目标

新版先解决四件高频事情：可靠接入平台、稳定归一化消息、组合业务处理器、低成本本地验证。公共 API 保持小，平台差异停留在 adapter 边界。

```text
Telegram / KOOK adapters         Sandbox HTTP
             \                   /
              ChatHubPlugin
              - dedupe
              - per-chat ordering
              - handler pipeline
                 /            \
       ChatCommandsPlugin    ordinary handlers
               |
       ChatBuiltinsPlugin / product plugins

Pluxel management UI -> typed RPC -> Vault + adapter lifecycle
```

## 包边界

| 包          | 责任                                         | 不负责                 |
| ----------- | -------------------------------------------- | ---------------------- |
| `contracts` | JSON-safe 消息、内容块、transport 契约       | 路由、状态、平台 API   |
| `hub`       | transport/handler 注册、调度、去重和顺序     | 命令、权限、用户数据库 |
| `commands`  | prefix 识别、参数 tokenize、command registry | 消息接入、权限策略     |
| `sandbox`   | 可重复的端到端输入输出与历史                 | 伪装具体平台全部语义   |
| `telegram`  | Telegram API、polling、双向转换              | 跨平台业务规则         |
| `kook`      | KOOK API、gateway 心跳重连、群聊/私聊转换    | 内部多 Bot manager     |
| `builtins`  | 最小运维命令                                 | 框架级默认策略         |

## 关键约束

1. `ChatMessage` 必须可序列化。旧设计把方法、原始 session 和平台行为塞进消息对象，导致测试、持久化和跨进程传递困难。新版回复通过 handler context 完成。
2. handler 是普通有序管线。返回 `stop` 才认领消息；异常只记录当前 handler，不中断后续 handler。
3. 同一 `(transport, conversation)` 严格串行，防止命令和状态更新乱序；不同会话不互相阻塞。
4. 注册返回幂等清理函数，并由消费插件挂到 `ctx.effects`。HMR/停用不保留幽灵 handler。
5. adapter 管理面常驻运行，token 只保存在 Pluxel Vault；未配置时状态为 `unconfigured`，不会注册 transport。保存凭据后动态鉴权并连接。
6. 插件依赖表达硬前置条件。commands 依赖 hub，builtins 依赖 commands；不使用全局 singleton 或 import-time registry。

## 从旧设计保留什么

- 保留声明文件与 build-time macro：平台 API 清单是可审阅的数据源，构建产物不在运行时读取文件。
- 保留具名 API、`$raw` 和 `$tool` 三层：常用调用有强类型，未知/新端点有逃生口，复杂消息操作由平台工具表达。
- 保留 normalize/adapter 边界和平台领域类型，不把 KOOK、Telegram 对象污染跨平台消息协议。
- 保留可组合的 conversation builder，但 builder 只存在于平台 SDK；`ChatMessage` 仍然是可序列化数据。
- 删除平台内部 manager、registry、配置 RPC 和 SSE；这些职责统一交给 Pluxel fork/config、Vault、typed RPC、SignalDB 和 lifecycle。

## 暂不加入的能力

- 全局用户身份合并：应基于明确产品需求和持久化模型做成独立插件。
- 内置 RBAC：授权对象和管理边界还未稳定，不应污染消息热路径。
- 全能 Parts DSL：先保持 `text/image/file` 三种传输友好的内容块；富文本由独立 renderer/adapter capability 演进。
- 把平台 SDK 塞进 hub：完整 KOOK v3 client 由 `@repo/chatbots-kook/api` 单独导出，hub 只保留跨平台消息契约。
- 重建一套平台控制面：adapter 只声明轻量 Pluxel UI，并复用 typed RPC、SignalDB、Vault、lifecycle 和日志服务。

## 下一步扩展顺序

1. 用真实业务插件验证 handler/command 契约。
2. 加入 webhook 模式与签名验证，适配无状态部署。
3. 按需求增加 Milky adapter，并让所有平台复用同一 conformance test suite。
4. 多 Bot 使用 Pluxel fork/config 实例化 adapter，不在 adapter 内重建 manager。
5. 有明确管理员场景后，再增加独立 policy plugin 和审计事件。

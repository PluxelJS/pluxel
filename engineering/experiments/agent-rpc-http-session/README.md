# Agent RPC HTTP 会话边界实验

日期：2026-09-25。对应 [RPC 提案](../../proposals/AGENT_RPC_COMMANDS.md)第 8、9、11、13 节。这是使用 Cap’n Web 0.12.0 的独立可执行探针，不提供 public RPC API，也不代表正式 session/executor 实现。

在仓库根目录运行：

```sh
node engineering/experiments/agent-rpc-http-session/check.mjs
```

脚本启动真实 Node HTTP listener，使用 `newHttpBatchRpcSession()` 发起调用，并通过 `nodeHttpBatchRpcResponse()` 在服务端执行 `RpcTarget`。预期输出包含 `requests: 16`、`calls: 8`、`rejections: 5`，以及 `stubs.opened = stubs.disposed = 16`。请求数为本探针固定场景的观测值，不是生产预算。

## 已通过的局部检查

| 边界                   | 断言                                                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话认证               | bearer token 查到固定 principal/session；`x-session-id` 与 token 不一致时 HTTP 403，handler 不进入。Alice 与 Bob 的请求独立记录。                                                                                           |
| 权限缩小               | session 方法集撤权、应用当前策略撤权、Bob 无 `slow` 权限均在每次调用时拒绝。异步授权暂停期间撤权，最终接纳检查挡住 handler。                                                                                                |
| generation 固定        | 旧 publication 撤销后以同名、同策略重新发布，旧 session 仍固定 generation 1 并被拒绝；新 session 绑定 generation 2 后可调用。                                                                                               |
| run 预算与背压         | 客户端每 run 最多 4 次请求、单个输入 JSON 最多 96 字节、最多 2 个排队调用且每次只发出 1 个调用；超限明确拒绝。脚本返回时仍有未完成请求，run 报 `RUN_PENDING_CALLS`、取消客户端等待并释放 stub；服务端工作仍由自身占用跟踪。 |
| owner admission 与排空 | 异步授权前取得 owner lease；owner 停止后不再接纳新调用，已进入 handler 的 `slow` 仍占用 owner。停止 Promise 在 `slow` 真实退出前不完成，退出后占用归零。                                                                    |
| 断线与引用清理         | 服务端在解码前断开一次请求；客户端报传输失败且不重放，handler 没有执行。探针创建的 16 个原生 stub 都显式 dispose。                                                                                                          |

上述拒绝在探针方法内编码为普通 `{ error: 'FORBIDDEN_OR_GONE' }` DTO。它只证明接纳顺序和拒绝位置，没有验证提案中的正式 `RpcResult` 错误投影。

## 仍未通过正式验收的部分

- 本探针没有发布制品、契约 hash、真实 Command mount、Plugin generation/effects 或 Host owner invocation。generation、session 与 owner 状态由脚本中的小型状态机模拟；不能据此宣称正式生命周期已实现。
- 预算仅在客户端按调用次数、输入值大小和本地队列执行。没有服务端请求体字节、输出尺寸、描述大小、跨 run 并发、总量、deadline 或隔离后端预算的强制限制；恶意客户端可以绕过本地调度器。
- 这里每个请求只有一个方法调用。顺序 await、并行批次、3/3/2 分批和不同 session 不混批已由[现有 HTTP 探针](../agent-rpc-commands/README.md)验证，本探针没有重复宣称完整 batching 实现。
- `RUN_PENDING_CALLS` 的客户端取消可能先于服务端 handler 退出。此处通过延后释放的 handler 和 owner lease 观察服务端继续工作；正式 session/executor 仍需携带受认证的执行 ID 请求取消，并等待远端确认退出或报告清理失败。
- owner lease 覆盖异步授权和 handler，不覆盖结果编码、HTTP 回复完成与连接断开后的资源结算。正式载体必须把这些阶段纳入 owner 保护，并验证断线后的已提交回执不被错误重试。
- 脚本只测试在 handler 前断线。handler 已执行但结果丢失的情况由[现有 HTTP 探针](../agent-rpc-commands/README.md)观察到一次请求和一次执行；正式系统仍需明确不确定结果诊断。
- 没有实现正式 `session.dispose()` / `Symbol.asyncDispose`、并发关闭复用同一 Promise、配置热更新或真实部署认证来源。会话 token 是本地固定测试值。

因此该实验增加了 HTTP 会话边界的可行性证据，第 13 节的完整 RPC 验收仍未通过；公共 RPC 入口应继续关闭。

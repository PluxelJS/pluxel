# TypeScript run 与隔离 HTTP session 整合实验

日期：2026-09-25。对应 [Agent RPC 提案](../../proposals/AGENT_RPC_COMMANDS.md)第 9–11 节。此目录只提供可执行实验，不创建公开包入口。它复用 [Podman 每次运行原型](../agent-rpc-sandbox/README.md)的 `executeSandboxedRun()`，并在宿主用 Cap’n Web 0.12.0 的 `newHttpBatchRpcSession()` / `nodeHttpBatchRpcResponse()` 调用真实 HTTP listener。

## 复现

在仓库根目录执行：

```sh
RPC_SANDBOX_IMAGE=cf5b3793df12 node engineering/experiments/agent-rpc-executor/check.mjs
```

本机 `docker` 是 rootless Podman 5.8.6 CLI，镜像 `cf5b3793df12` 是本机已有 Node 24.20.0；其他机器须提供可信的 Node 24 镜像。脚本要求仓库的 TypeScript 7 CLI、Cap’n Web 0.12.0 和 Podman 原型的环境。镜像不自动拉取。

## 已观察

| 场景                 | 结果                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 编译                 | `code` 作为 TypeScript async 函数体编译。错参给 `CODE_TYPECHECK`，语法错误给 `CODE_SYNTAX`；诊断行号回映到原始代码第 1 行，执行前没有业务调用。         |
| 普通 Promise         | `rpc.open('text')` 取得逻辑 API。顺序两次 await 对应两个 Cap’n Web HTTP batch；并行两次调用合成一个 batch。每批原生 stub 显式释放，创建与释放数量相等。 |
| 调用跟踪和未等待调用 | 程序返回时仍有 `slow` Promise，结算为 `RUN_PENDING_CALLS`；容器退出时宿主仍跟踪一项已接纳调用，约 0.5 秒后真实服务端工作结束才完成 run 清理。           |
| 取消                 | `AbortSignal` 使容器停止并返回 `ABORTED`；已接纳 `slow` 调用继续由宿主跟踪，排空后释放 stub。                                                           |
| JSON 出口            | 普通对象与数组交付，顶层 `undefined` 归一化为 `null`；BigInt 返回 `OUTPUT_ENCODING`。递归检查普通对象、循环、accessor、节点/深度和 64 KiB 字节上限。    |

实验的返回对象使用 `{ ok, value | error }` 形状，并标明 `phase`。已观察到的服务端调用以 `outcome: 'unknown'` 报告；`observed-N` 是实验内的跟踪号，不是正式协议 `callId`。每次运行沿用隔离原型的文件、网络、内存、PID、CPU、墙钟及 RPC 数量/并发限制。

## 正式集成缺口

- 这个实验在容器内先走 toy Unix socket JSON 网关，再由宿主转到 Cap’n Web HTTP；正式实现需要将生成契约、session 身份、每次 run 的执行 ID 与受认证网关绑定。当前没有接入真实 Command 发布、方法制品、权限、owner lease、Services mount 或 `packages/services/src/rpc` 的内核。
- 这里的 TypeScript 声明固定为 `text.echo/slow` 样例，未由 `describe` 制品生成。编译器只检查类型；运行时代码仍处于完整 Node 进程中，可通过动态代码或全局对象触及容器内能力。正式执行器必须限制允许的全局能力、代码尺寸和 import，并继续依靠操作系统隔离。
- 未等待调用的实验 wrapper 发现 pending Promise 后短暂等待 100 ms 以便请求到达 toy 网关，然后以专用退出码停止容器。这验证结算与服务端排空路径，但不是正式的协议级取消握手。正式实现需从调用创建起记录真实 `callId`，区分未发送的 `not_started` 与已发送的 `unknown`，取消排队项，并等待服务端确认或报告清理失败。
- HTTP batching 目前由宿主的 10 ms 窗口聚合 toy 网关调用；正式客户端应在受限程序的同一调度轮有界组批，逐次检查 run/session admission，不跨 run 混批。这里没有测试跨 principal、撤权、网络断线后不重放或结果丢失；其他独立探针已有局部证据。
- JSON 检查是实验实现；正式出口仍需完整输入/输出预算、严格错误投影、业务回执和编码失败后的不确定结果说明。实验中的错误分类尚未覆盖提案完整 `RunFailure`，也没有本地 Better Result、正式配置/运维接口和诊断日志。

因此，实验证明了 TypeScript 编译、普通 Promise 程序、真实 HTTP session 与 Podman 停止后排空可以串联；正式 RPC 入口仍需生产集成和端到端回归。

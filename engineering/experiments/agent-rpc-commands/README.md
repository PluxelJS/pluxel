# Agent RPC 开工前探针

日期：2026-09-25。对应 [`AGENT_RPC_COMMANDS.md`](../../proposals/AGENT_RPC_COMMANDS.md) 第 13 节的三个开工门槛。这里是临时实验，不是公开 API、RPC 实现或支持矩阵。

## 运行

在仓库根目录执行：

```sh
node engineering/experiments/agent-rpc-commands/check-types.mjs
node_modules/.bin/tsc -p engineering/experiments/agent-rpc-commands/tsconfig.json --pretty false
node engineering/experiments/agent-rpc-commands/check-contract.mjs
node engineering/experiments/agent-rpc-commands/check-http.mjs
RPC_SPIKE_IMAGE=cf5b3793df12 node engineering/experiments/agent-rpc-commands/check-sandbox.mjs
```

最后一项使用本机已有的 Node 24 容器镜像，不拉取镜像。`docker` 命令在这台机器上是 Podman 5.8.6，rootless、crun、seccomp 与 cgroup v2。镜像 ID `cf5b3793df12` 仅供本机重跑；其他机器须提供受信任的 Node 24 镜像给 `RPC_SPIKE_IMAGE`。

## 观察

| 项目                  | 已验证                                                                                                                                                                                                                                                                                                                                                                                      | 尚未验证                                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型制品              | TS 6.0.3 compiler API 从 `publisher.ts` 的静态方法表取到跨模块 Command 的 `StaticEncode` wire 类型和 `Result` 成功值；DTO 被内联为闭合声明。`offset` 的 wire 类型为 string，handler decoded 类型为 number。生成的 `generated-client.d.ts` 通过仓库 TS 7.0.2 检查，错参和不存在的结果字段被拒绝。                                                                                            | 真正的 `defineCommand` 实现、Vite/Rolldown 语义 pass、发布包跨包解析、制品注入与实际发布处校验。此处 `provider/commands.ts` 是声明级替身。TS 7 CLI 不带 JS compiler API，正式方案须确定 TS 7 的查询/编译接口或兼容的工具版本。            |
| 授权 hash 原型        | schema 节点上的文案变化保持 hash，制品内容仍变化；方法到 Command 的绑定、默认值、名为 `description` 的业务字段默认值、新增方法都会改变 hash。                                                                                                                                                                                                                                               | 该算法尚未接入真实 TypeBox 规范化结果或发布制品；原型的 hash 不构成正式协议或实际旧制品拒绝证据。                                                                                                                                         |
| Cap’n Web 0.12.0 HTTP | 本地真实 HTTP 服务和最小 run 内调度器：同一逻辑 API 顺序 await 发两次请求；同轮两个调用合成一次请求；8 个调用按上限 3 分为 3/3/2；两个带不同认证 token 的会话各自成批；断线前后两种场景各只发一次，后者 handler 已执行但结果丢失；10 个 native stub 全部显式 dispose，run 结束活跃数为 0，dispose 后调用被拒绝。第 13 节第 3 项的**本地技术可行性**已有可重复通过证据。                     | 调度器只是探针，未连接正式 RPC session、principal、access、run Pending Calls 判定、服务端 owner 占用及请求取消。活跃 stub 计数证明本探针释放其创建的引用，不证明 Cap’n Web 内部堆对象已被 GC；生产 run 的完整资源追踪和背压仍须集成验证。 |
| 隔离后端              | 当前 Linux 上 rootless Podman 容器使用 `--network none --read-only --memory 64m --memory-swap 64m --cpus 0.5 --pids-limit 32 --security-opt no-new-privileges --cap-drop ALL`。本机 `/home/ahdg` 不可见、外网 fetch 失败、cgroup `memory.max` 为 67108864、超内存退出 137，控制器 kill 无限脚本退出 137。Unix socket 显式挂载的演示网关在沙盒被杀后仍记录工作占用，直到真实服务端工作结算。 | 只是所选机器和镜像上的小样本。没有正式隔离执行器、完整文件系统/凭证泄露审计、每 run RPC 数量预算、容器启动与清理策略、跨平台支持；演示网关不等同生产 session/owner admission。需实际后端与预算集成后才能宣称第 13 节第二项通过。          |

HTTP 探针的关键结果可以由脚本输出直接核对：`requests.sequential = 2`、`requests.parallel = 1`、`requests.bounded = 3`，`batches.bounded` 的调用数为 `3, 3, 2`；`drop-after` 的请求和 handler 调用都为 1，客户端只收到传输失败，不能据此推断未提交。`native.opened = native.disposed = 10` 且 `native.active = 0`。每个 HTTP 请求只带一个会话的 token，服务端逐次校验。此处批次上限仅按调用数计算，未验证请求字节预算、排队容量或背压。

三个开工门槛中，HTTP 通道的上述行为已在当前版本和本机得到可判定的正面结果；类型制品与隔离后端仍缺正式构建和运行集成，RPC 公开入口保持关闭。Cap’n Web HTTP stub 一次一批、工作区 TS 7 CLI 不提供旧 JS compiler API，仍是正式方案必须处理的技术点。

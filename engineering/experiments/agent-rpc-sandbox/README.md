# Agent RPC 每次运行隔离执行器原型

日期：2026-09-25。此目录验证 [`AGENT_RPC_COMMANDS.md`](../../proposals/AGENT_RPC_COMMANDS.md) 第 13 节第二项的隔离后端关键行为。`executor.mjs` 导出 `verifyBackend(image)`、`defaultBudgets` 和 `executeSandboxedRun({ code, image, budgets, onInvoke, onStarted })`，供本目录测试程序复用。它不是公开 API 或生产执行器。

## 复现

在仓库根目录执行：

```sh
RPC_SANDBOX_IMAGE=cf5b3793df12 node engineering/experiments/agent-rpc-sandbox/run.mjs all
```

`all` 可换成单项名称，见 `run.mjs`。本机 `docker` 命令指向 Podman 5.8.6 CLI，使用 rootless、seccomp、cgroup v2 和 crun。本机已有 Node 24.20.0 镜像 `cf5b3793df12`；其他机器需要提供可信的 Node 24 镜像 ID。脚本用 `--pull=never`，不拉取镜像。宿主用仓库 `node_modules/.bin/tsc` 编译 TypeScript，再把 JS 交给容器执行。

## 每次运行预算

| 资源       | 默认预算及执行位置                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 文件       | 根文件系统只读；只有 `/tmp` 是 8 MiB、`noexec,nosuid` 的 tmpfs；只读挂载仅含 Unix socket 的目录，宿主 canary 文件留在挂载目录外。 |
| 网络与进程 | `--network=none`；独立 PID、IPC、UTS namespace；`--user=1001:1001`，`--cap-drop=ALL`，`no-new-privileges`。                       |
| 内存与 CPU | cgroup `--memory=64m --memory-swap=64m --pids-limit=16 --cpus=0.5`。                                                              |
| 墙钟       | 宿主默认 2500 ms，达到期限执行容器 kill；死循环用例缩到 300 ms，内存用例延到 3000 ms。                                            |
| RPC        | 每 run 最多接纳 4 次、同时最多 2 项、请求体最多 1024 字节；超限分别返回明确错误。网关最多 6 个连接，连接和请求各有 1000 ms 超时。 |
| 收尾       | 容器退出后等待已接纳的服务端工作，最多 2000 ms。超过期限报错；无论成功或失败都强制移除具名容器、关闭网关并删除临时目录。          |

预算是 `defaultBudgets` 中的原型默认值，调用时可覆盖并受参数校验。RPC 数量与并发在宿主网关接纳点计数；拒绝的请求不进入 `onInvoke`。`onInvoke` 是宿主提供的 toy 方法，不是 Command 授权实现。

## 本机观察

`all` 九项运行通过：宿主路径及独立 canary、宿主 PID 和外网不可访问；容器 PID 为 1，子进程 PID 为 9；`memory.max=67108864`、`pids.max=16`。正常 RPC 返回 `hello`。无限循环达到墙钟限制退出 137；超内存脚本退出 137，未触发墙钟 kill。手动 kill 与客户端主动断线时，容器退出后服务端各仍有一项已接纳工作，约 0.5 秒后结算。恶意文件写入 `/etc` 与只读挂载 `/rpc` 均得到 `EROFS`。第五次顺序 RPC 被总量预算拒绝；第三次同时 RPC 被并发预算拒绝，服务端最大活动数为 2。

## 生产集成缺口

这是单机小样本；未接入真实 Command、Cap’n Web、session/owner 鉴权、持久回执与生产生命周期。`code` 当前通过环境变量传入，没有代码尺寸预算和可信镜像供应链。该 toy 网关没有完整慢请求/连接洪泛审计，`onInvoke` 若超过排空期限只能报错，不能自动回滚其副作用。内存退出未读取内核 OOM 事件计数。正式支持平台、凭证/挂载审计、重启恢复、全局资源配额与可观测性仍需设计和验证。此原型不能单独证明第 13 节第二项的生产门槛已经通过。

# RPC 隔离执行器运行边界

`packages/services/src/rpc/executor.ts` 目前是内部实现，没有 `@pluxel/services/rpc` 公开安装入口。它借用已获精确契约授权的 RPC session，在一次运行内编译受限 TypeScript，再用 Podman 执行生成的 JavaScript。当前公开的 RPC 服务只负责 Command 发布、发现与会话调用，见[用户文档](../docs/runtime/rpc.md)。

## 已验证的平台

当前实现只接纳 Linux amd64、rootless Podman 5.8.6、seccomp、cgroup v2、crun 和可用的 Linux `flock`。容器镜像必须由部署者预先取得并核对来源；执行器只接受完整的 64 位本地 image ID，创建时与 inspect 结果逐字核对，后续运行使用该 ID 和 `--pull=never`。执行器的启动探针要求 Node 24.20.0。仓库中的[最小镜像定义](rpc-executor-image/Containerfile)固定 linux/amd64 的 Docker Official Image Node manifest digest，并设置运行 UID/GID 为 1001；它不包含业务代码或额外工具。

创建执行器会启动一个短暂的探针容器，使用与实际运行相同的隔离参数。探针检查容器内的内存、PID 与 CPU cgroup 上限、只读根目录、`/tmp` 的 tmpfs 大小、无外部 IPv4 路由、UID/GID、空有效 capability、`no-new-privileges` 和 seccomp 模式。它还验证容器 UID 1001 能读取宿主当前用户独占的 `0700` 目录和 `0600` 文件。任何关键检查失败都会拒绝创建。此检查验证当前后端确实施加了预算与本次用户映射；镜像来源的信任仍由部署者负责。

## 当前预算

| 项目            | 每次运行的默认值与执行点                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| 脚本            | UTF-8 最多 65,536 字节；宿主 TypeScript 7.0.2 只解析本次生成的程序和契约声明，不解析脚本另加的 import                |
| 墙钟            | 容器启动后 2,500 ms 由宿主 kill；Podman 另设 3 秒独立超时，使宿主进程崩溃后容器仍会停止；结算为 `RUN_LIMIT`          |
| 内存、CPU、进程 | cgroup 64 MiB、0.5 CPU、16 PID；超限由容器后端约束                                                                   |
| 文件与网络      | 根文件系统只读；`/tmp` 为 8 MiB 且 `noexec,nosuid`；仅挂载只读程序目录和本次 Unix socket 目录；`--network=none`      |
| RPC             | 每 run 最多 4 次，正在执行的调用最多 2 次，请求体最多 1,024 字节；同一 run 跨 HTTP batch 共用计数                    |
| 输出与排空      | JSON 输出最多 65,536 字节；容器停止后最多等待 2,000 ms 报告排空故障，`executor.close()` 继续等待尚未退出的服务端工作 |
| 宿主接纳        | 同一用户、`TMPDIR` 与 Podman 存储身份下，跨进程同时最多 2 个 run；各 executor 可进一步收紧，不能提高这个上限         |

`run({ deadlineMs })` 可另设绝对 Unix 毫秒期限，先到的调用方取消、期限或墙钟预算决定控制失败分类。`run()` 在入口同步固定所选描述集合，重复 API ID 以 `CONTRACT_CHANGED` 拒绝；类型检查与宿主方法允许表使用这同一集合。网关记录已收到的 `callId`，容器正常交付控制消息时还报告已创建的调用；宿主没有观察到分派的 ID 保守记为 `unknown`。容器异常退出且控制消息未送达时，宿主无法列出完全未到达网关的 ID。`outcome: 'unknown'` 不能作为未写入证明。传输拒绝或网关预算超限会封闭该 run，脚本 catch 不能将其结算为成功。运行完成时宿主立即封闭新 RPC 接纳，并按宿主未完成请求判定 `RUN_PENDING_CALLS`。即使脚本伪造完成消息，仍须等待已接纳调用结算。清理失败会使 `run()` 返回错误，`executor.close()` 不会报告成功。

内部 `RpcExecutorOptions.observe` 可记录实际编译尝试、容器启动尝试及已认证的 RPC HTTP 请求；事件带 UTC 时间和 run ID。观察回调的异常被隔离，不能改变运行结算或写入回执。模型请求、业务后端请求及工具输出须由各自边界单独记录；这些观察事件本身不构成完整的模型收益记录。

## 宿主异常退出后的回收

执行器在当前 `TMPDIR` 的私有 `pxrpc` 目录记录进程与每次运行的随机身份。owner 记录在全局准入锁内先写入私有 staging 目录，再原子发布；扫描在同一锁内清理崩溃留下的 staging。每次 Podman 启动前先写入运行记录与锁文件，再用 Linux `flock` 包住 Podman CLI；宿主崩溃时，仍在创建容器的 CLI 保持该锁。跨进程接纳使用同一目录的全局 `flock`：持锁完成旧 run 回收、计数和新 run 记录写入；清理容器及删除记录也持锁。锁的宿主 pipe 在进程异常退出时关闭。无法取得锁、无法确认旧 owner 身份或回收失败时保守拒绝本次接纳。下次创建执行器会后台扫描旧记录；`close()` 等待这次扫描并报告回收失败。

扫描用 Linux boot ID、PID 和 `/proc/<pid>/stat` 的进程启动时间确认 owner 已退出，并要求 Podman 的 graph/run root 与记录相同。身份不可读取时保守跳过。回收先确认旧 CLI 的锁已释放，再按记录中的容器名查询 Podman，并逐项核对完整容器 ID、随机 owner/run 标签、镜像 ID 和只读挂载源；运行中的容器先按该 ID 发送 kill，再删除。容器不存在或确认删除后才删除本次临时目录。正常运行时即使 `podman run -d` 返回失败，也按预先记录的容器名检查并回收可能已经创建的容器；归属无法证实时保留目录供排查。

回收只发现同一 `TMPDIR` 下的旧记录；重启后更换 `TMPDIR` 或 Podman 存储身份时，须按旧环境运行回收或人工处理。当前扫描没有跨主机协调，也不提供后台常驻清扫或独立告警通道；只有创建下一执行器才触发回收。真实 Podman 回归覆盖存活 owner 不被清理、宿主进程被强杀后的运行中容器回收，以及 Podman 创建成功但 CLI 报错时的正常路径回收。

容器内 Node VM 只用于加载脚本，**不是**凭据边界。脚本可取得同一容器进程的短期 RPC token；宿主只接受本次 run、session 和已批准方法表中的调用，并在接纳点执行数量与并发预算。不得把宿主文件、长期凭据或业务 SDK 直接挂入容器。已验证恶意脚本在当前 Podman 配置下读不到宿主测试文件，也无法连通外网；此证据不覆盖其他平台或镜像。

宿主把本次 token 写入 `0600` 的临时 env 文件，Podman CLI 参数不含 token。`--userns=keep-id:uid=1001,gid=1001` 使容器 UID 1001 对应宿主当前用户；运行、源 TypeScript、生成程序和 Socket 目录均为 `0700`，Socket 文件为 `0600`。启动探针和真实 RPC 回归已验证容器可以读取私有挂载，且挂载目录保持这些权限。在标准 POSIX 文件权限下，其他本地 UID 无法遍历这些目录；相同 UID、宿主特权用户和 Podman 后端仍处于宿主信任边界。其他部署主机仍需运行探针和真实回归确认映射及文件系统权限。

## 验证与故障处置

本地运行 `sh scripts/verify-rpc-executor-image.sh` 可按固定 digest 拉取 Node 基底，检查平台，用仓库中的最小定义构建，核对 Node 版本和 UID/GID，并以构建出的完整本地 image ID 运行真实 Podman 回归。目标主机已有受信镜像时，也可直接运行：

```sh
RPC_SANDBOX_IMAGE=<image-id> pnpm --filter @pluxel/services exec vitest run tests/services/rpc-executor.test.ts tests/services/rpc-http.test.ts
```

最小定义与固定基础 digest 使输入可审阅、可重新构建；构建后须使用**本次**输出的完整本地 image ID。digest 固定了从 Docker Hub 获取的基础镜像内容。旧的本机 DSH 镜像 ID `cf5b3793df122c6491ce7876e7bf976bad2fded80d4f92854fac66c5adf73361` 只作历史复现定位，不是这个最小定义的产物，也不能替代部署者的镜像来源校验。可用 `docker --version`、`docker info --format '{{json .Host}}'` 和 `docker image inspect <image-id>` 检查后端与镜像。测试中的 `docker` 命令指向 Podman CLI。

## 镜像来源

当前只验证本机按固定基础摘要构建的最小镜像，并用完整本地 image ID 运行执行器探针及真实 Podman 回归。执行器不会拉取镜像；部署者须自行取得、核对来源并在目标主机重复探针。仓库此阶段不提供镜像发布或远端验签流程。

执行器创建失败表示平台或隔离预算未通过探针，不应回退到 Node VM 或普通 worker。`RUN_TRANSPORT`、`RUN_LIMIT`、`ABORTED` 和 `TIMEOUT` 不保证写入没有发生；按业务回执、已有 operation ID 或领域查询确认。排空失败时保留调用 owner 的真实占用，并等待其结算；忽略 signal 的业务可能使关闭一直等待。检查本次 run 的 `callId` 与宿主诊断后再采取应用级恢复措施。

当前没有跨主机资源配额、生产可观测性或已验证的远端镜像供应链。跨进程上限只协调相同 `TMPDIR` 与 Podman 存储身份的本机进程。Podman 的独立超时只约束容器运行时间；异常退出后的回收仍依赖下次创建执行器和相同的本地运行环境。执行器仍为内部实现，公开安装入口须在目标部署环境验证后另行交付；阶段状态见[重构提案](proposals/AGENT_RPC_COMMANDS.md)。

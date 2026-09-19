# Host Development Console

用户工作流与 API 示例见 [在线开发控制台](../docs/development/dev-console.md)。本文件记录执行边界和实现约束。

## Ownership 与包边界

`host({ entry, devConsole: true })` 安装可选的本地执行服务。CLI 是外部提交者；脚本由现有 SSR ModuleRunner 求值，并借用当前 Host root。控制台不是 Plugin，不安装 Context property，不创建 test host、第二个 logger 或第二个 database。

- `@pluxel/host-dev/console`：独立脚本类型、typed targets、稳定错误与借用的 `RootContext`。
- Host-dev：每 run 的基础插件/配置操作、执行队列、源码加载、IPC、Vite 更新 barrier、host epoch 与清理。其中宿主操作仅依赖 Core/Host；控制台不依赖官方服务或其 optional peers。
- Services 的 `vitePreset()`：组合官方开发附件，将 `devConsole` 开关交给通用 `host()`；不实现控制台。
- 应用脚本：显式 import 服务 token/API，通过 `dev.ctx` 访问已安装能力，并拥有直接调用的取消传递与资源释放。
- CLI：只做 discovery/提交/结果/取消，不求值 Plugin，也不依赖开发驱动的发布产物。

Dev API 不继承 RuntimeTestHost。插件与基础配置操作直接委托 Host，不要求 Management，不复制其协议或展示层。服务操作使用各包现有公开契约，不注册控制台适配器或修改 Context shape。

Coding agent 对已运行应用的诊断和修改使用此控制台；隔离回归使用 test host。交互按“发现实例 → 固定 root/instance → 提交普通 TypeScript export → 检查执行状态、领域结果与日志”组织，具体步骤以用户指南为准。跨命令保留业务 ID、runId 和 JSON cursor，不把 live Plugin/Workbench handle 当作持久会话状态。Workbench 操作使用领域包的 `openLocalWorkbenchEntry(dev.ctx, { target, entry, principal, signal })`；真实 descriptor 推导 RPC 类型，项目提供 principal，脚本用 `using` 持有 entry，并通过 `detachWorkbenchPortableValue` 释放结果 transport 后返回普通数据。CLI 或未来编辑器必须保留实例身份与运行结果，不能把请求接纳、脚本完成或领域操作成功混为同一状态。

## 提交与执行

一个 run 调用一个 project-local TS/JS 模块的导出函数，输入从 unknown 校验。`defineDevConsole()` 只提供回调上下文推导；函数只有一个 `dev` 参数，包含本次执行的 `id/input/signal` 与宿主访问。控制台执行不是 Plugin generation，不进入插件图，不因 HMR 自动重放。模块顶层不是可重复操作入口。一次运行拥有 id、signal、临时 driver scope；宿主业务状态持续存在。

接纳前验证协议、实例凭据、允许的 realpath、输入/源码限额及函数导出名。入口不能在 .pluxel/.git/node_modules。已由 Vite 合法加载的工作区依赖可位于 Vite root 之外；追踪时只接受真实 absolute file，忽略虚拟/NUL id 和 node_modules。

入口在提交、prepare 与 load 后核对内容 hash，变化报 source_changed。依赖使用执行时当前模块图，不承诺整个文件系统 snapshot。公共失败保留阶段（admission/load/execute/encode/cleanup），生产领域结果不被执行 envelope 吞并。

脚本返回值先按纯 JSON 数据约束复制，拒绝 accessor/class/capability/toJSON side effect。undefined 遵循原生 JSON 约定；非有限数字、BigInt、循环等明确失败。结果包含 host epoch 和前后 catalog/state revision；日志数据由脚本显式读取并返回。失败或编码错误不回滚已经提交的操作，也不自动重试。

## Vite 更新与执行边界

每个 Vite server 只有既有 SSR runner；不追加一次性 query ID 创建无限 namespace，不全量 clearCache，不建立第二套 import cache。运行未改变的导出函数可以直接复用模块。

每次调用先核对已知依赖版本。尚未观察的修改等待真实 Vite watcher 在 route 同步入队时确认，再等待有限 barrier；此等待受 run signal 与 deadline 约束。等待范围覆盖统一开发驱动已经接纳的源码与来源更新序列。不以全局 idle 或 sleep 模拟源码已应用。

真实 route admission 对已跟踪源码记录有界 hash 并唤醒等待者。来源 listener 与 Vite hook 的确认不重复失效同一已发布 constructor。控制台不合成文件事件、不吞真实 watcher 事件。删除/无法读取的文件仍进入正常 removal 路径。

首次加载没有历史依赖版本，保证的是当前已提交宿主和已观察更新；不声称发现所有尚未观察的磁盘修改。typed target 与当前 catalog 身份不符时明确失败。禁用或忽略 watcher 的已知依赖修改可能等到 run timeout，控制台不会另建更新权威。

失效必须发生在 route publication 之前。新 constructor 已成为 committed authority 后再失效，会令脚本 import 身份与 running Plugin 分裂。static catalog 更新采用精确 importer invalidation，未变化的 built Plugin 保持当前实例。script-only 更新不改变 catalog 或重建 root。

脚本体不锁住整个 coordinator/HMR；它可以调用 restart 等异步 mutation。后台任务、浏览器和未来更新可交错，单个脚本不是全局事务。

## 操作 API 与资源

`plugins.require()` 对 typed constructor/`{plugin,forkId}` 做当前 catalog identity 检查；地址只用于管理操作，不用来声称具体实例类型。普通 JS 实例没有通用撤销语义，跨 await 使用过期对象的限制需诚实说明。

`plugins.isRunning()` 同步读取当前 running 状态。`list/status` 返回 Host 状态，`start/stop/restart` 返回 Host 所有的 `PluginApplyReportSnapshot`；配置结果使用相同报告投影，保留 `saved/application/applyFailure`。投影只把 Core slot 转成稳定地址，保留生命周期问题与错误，不将提交成功等同于启动成功。Management 与控制台共享投影，不维护平行协议。`updates.latest()` 读取 Host 最近的应用更新，覆盖尚无插件节点的候选失败。

`dev.ctx` 是本次执行借用的 RootContext；访问 getter 需要 scope 仍开启。通过 `ctx.require(Token)` 访问 all/root capability；owner-only capability 仍需要真实插件 Context。已经取得的 Context、实例或 handle 不能被 JavaScript getter 撤销，不得跨 run/epoch 缓存。执行不拥有宿主 effects，也不提供同名的临时清理设施；脚本使用 `using`、`await using` 或 `try/finally`。

每 run 的 DevScope 在 abort 时关闭 admission；dispose 等待已接纳的 Host 操作。配置/lifecycle mutation 沿生产路径 settle，不声称强制中断或回滚。直接服务调用、Plugin 方法和用户自行创建的资源不受自动跟踪；脚本显式传递 `dev.signal`，await 操作并使用 `using`/`try/finally` 释放资源。

full-host replacement 先 abort 旧 run、drain 已跟踪 Host 操作，再释放旧 root。后续 run 使用新 epoch。任意未协作脚本本体不能被强制终止；旧 run 不转接新 root，执行 slot 在其 settle 前仍被占用。

## 日志

Core 始终提供 `ctx.logger`，不要求插件 import 日志包。宿主 logging 配置拥有输出、过滤与 store；开启控制台不会安装 Logging 或自动增加 store。脚本显式解析已安装的 `Logging` 能力，调用既有 `RuntimeLogging`/store API，返回有界普通数据。`flushStores()` 只刷 store sink buffer，不依赖 policy persistence；正常 `flush()` 同时刷 store 和 policy。

日志读取保留真实 epoch、sequence、retention 和 gap 契约，游标只是时间窗口，不提供因果隔离。控制台不提供另一条 HTTP/log follow 路由，也不在 run envelope 自动附加日志边界。

## 执行通道与预算

首版使用具有文件权限保护的 Unix socket，仅支持 Unix 系统。project discovery 目录 0700、描述文件 0600，socket 放在当前用户私有短临时目录；nonce/instance/root/protocol 握手发生在求值前。它是受信任项目代码执行能力，不是隔离恶意代码的 sandbox，也不通过 Vite 公共 HTTP listener 暴露。

实例发现默认止于 cwd 向上最近的 package.json 所在目录；显式 root 使用 realpath。只在选定 root 下探测描述文件，握手核对 instanceId/root，服务端核对 instanceId/nonce。没有服务不回退父项目，多个服务不猜测默认实例，instance selector 也不扩大 root 搜索范围。Vite root 与 package 目录不同时由调用方显式指定 root。

协议固定为单请求/单响应 JSON 行。CLI 独立实现最小 wire contract，真实 client/server 互操作测试保护一致性；协议是 internal，不导出业务 RPC client 或 transport adapter。同步 CLI 在 stderr 先给带 root/instanceId/runId 的 accepted receipt，stdout 保持单一最终 JSON；run/result/cancel snapshot 也带 root。客户端错误以 code 供分支处理，以 context 和 hint 提供目标与恢复步骤；多实例只返回公开候选 metadata，不输出 nonce 或 socket path。

| 预算                 | 上限/默认                                      |
| -------------------- | ---------------------------------------------- |
| 同时执行/排队        | 1 / 16                                         |
| run timeout          | 默认30秒，最多5分钟，覆盖排队与执行            |
| 输入/输出            | 各1MiB、64层、100000节点                       |
| frame / open sockets | 2MiB / 32，socket空闲5秒关闭                   |
| 完成结果             | 最近100个，总计16MiB；不保留已完成的大输入     |
| admission tombstones | 每实例100000次，到限拒绝，不因结果过期允许重放 |
| 脚本入口/本地依赖    | 128 / 每入口4096；每源码文件1MiB               |

取消终态保留取消原因 `error`；若实际执行抛错不同于取消原因，另存 `executionError`。错误诊断按标准 AggregateError/SuppressedError 有界展开消息（深度 3、最多 16 节点、每组至多 4 个 Aggregate 子错误、最终 4096 字符，循环截断），不根据 cause 猜测业务/清理阶段。

queued 取消不执行；running 取消保持 cancelling，直到真实代码 settle。断线/超时不自动重放。结果过期与执行结果不确定是不同失败；进程崩溃后的 exactly-once 不作承诺。

## 实现与验证入口

- `packages/host-dev/src/console.ts`、`src/dev/`：脚本契约、Host 操作与 run scope。
- `packages/host-dev/src/console/`：队列、协议、IPC 与 Host attachment。
- `packages/services/src/vite.ts`：官方开发附件组合。
- `packages/cli/src/dev/client.ts`、`src/commands/dev.ts`：实例发现与命令交互。
- Host-dev console tests：无服务 Host 的插件/配置操作、取消、Host replacement 与公开脚本入口。
- Host-dev console/Vite scenarios：共享执行器、源码/HMR、JSON/socket 边界及 CLI 互操作。
- Services Vite scenarios：真实 watcher 恢复、服务 replacement、HTTP/WebSocket 与 Workbench 制品。

修改 public types、loader admission 或协议时，检查实际脚本调用边界，并运行直接 owner 的测试与类型检查。服务脚本遵循相应能力原有的回归覆盖。

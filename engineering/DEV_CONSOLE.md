# Runtime Development Console

用户工作流与 API 示例见 [在线开发控制台](../docs/development/dev-console.md)。本文件记录执行边界和实现约束。

## Ownership 与包边界

Vite route 的 `devConsole: true` 安装可选的本地执行服务。CLI 是外部提交者；脚本由现有 SSR ModuleRunner 求值，并借用当前 runtime root。控制台不是 Plugin，不安装 Context property，不创建 test host、第二个 logger 或第二个 database。

- `@pluxel/runtime/dev`：独立 dev 作者类型、typed targets、必要稳定错误；导入无安装副作用。
- runtime internal `createDevConsoleScope()`：每 run 的真实 use case、owner-aware capability 与资源接线。
- runtime-dev `console`：Vite 执行根、源码准备、执行队列、内部 socket 协议及结果保留。
- static/dynamic Vite：host epoch attachment、观察更新 barrier、watch admission、startup log defaults 和 shutdown。
- CLI：只做 discovery/提交/结果/取消，不求值 Plugin，也不依赖 private runtime-dev 的发布产物。

Dev API 不继承 RuntimeTestHost。配置、commands、HTTP、Workbench 复用生产事实及相同数据契约；test 的 fixture/catalog/strict assertions 与 dev 的当前宿主控制、真实 apply report 各自独立。不得用新 dev API 绕过 graph coordinator 或修改 Context shape。

Coding agent 对已运行应用的诊断和修改使用此控制台；隔离回归使用 test host。交互按“发现实例 → 固定 root/instance → 提交普通 TypeScript export → 检查执行状态、领域结果与日志”组织，具体步骤以用户指南为准。跨命令保留业务 ID、runId 和 JSON cursor，不把 live Plugin/Workbench handle 当作持久会话状态。CLI 或未来编辑器必须保留实例身份与运行结果，不能把请求接纳、脚本完成或领域操作成功混为同一状态。

## 提交与执行

一个 run 调用一个 project-local TS/JS 模块的导出函数，输入从 unknown 校验。模块顶层不是可重复操作入口。一次运行拥有 id、signal、临时 driver scope；宿主业务状态持续存在。

接纳前验证协议、实例凭据、允许的 realpath、输入/源码限额及函数导出名。入口不能在 .pluxel/.git/node_modules。已由 Vite 合法加载的工作区依赖可位于 Vite root 之外；追踪时只接受真实 absolute file，忽略虚拟/NUL id 和 node_modules。

入口在提交、prepare 与 load 后核对内容 hash，变化报 source_changed。依赖使用执行时当前模块图，不承诺整个文件系统 snapshot。公共失败保留阶段（admission/load/execute/encode/cleanup），生产领域结果不被执行 envelope 吞并。

脚本返回值先按纯 JSON 数据约束复制，拒绝 accessor/class/capability/toJSON side effect。undefined 遵循原生 JSON 约定；非有限数字、BigInt、循环等明确失败。结果包含 host epoch、前后 catalog/state revision 和可用的日志边界。失败或编码错误不回滚已经提交的操作，也不自动重试。

## Vite 更新与执行边界

每个 Vite server 只有既有 SSR runner；不追加一次性 query ID 创建无限 namespace，不全量 clearCache，不建立第二套 import cache。运行未改变的导出函数可以直接复用模块。

每次调用先核对已知依赖版本。尚未观察的修改等待真实 Vite watcher 在 route 同步入队时确认，再等待有限 barrier；此等待受 run signal 与 deadline 约束。static 使用 route update tail；dynamic 同时覆盖 Vite route tail、loader 的已观察 debouncer batch 与 execution-lock snapshot。不以全局 idle 或 sleep 模拟源码已应用。

真实 route admission 对已跟踪源码记录有界 hash 并唤醒等待者。dynamic 早期 listener 只负责 publication 前失效，较晚的 Vite hook 负责确认入队；确认本身不再次失效。控制台不合成文件事件、不吞真实 watcher 事件。删除/无法读取的文件仍进入正常 removal 路径。

首次加载没有历史依赖版本，保证的是当前已提交宿主和已观察更新；不声称发现所有尚未观察的磁盘修改。typed target 与当前 catalog 身份不符时明确失败。禁用或忽略 watcher 的已知依赖修改可能等到 run timeout，控制台不会另建更新权威。

失效必须发生在 route publication 之前。新 constructor 已成为 committed authority 后再失效，会令脚本 import 身份与 running Plugin 分裂。static catalog 更新采用精确 importer invalidation，未变化的 built Plugin 保持当前实例。script-only 更新不改变 catalog 或重建 root。

脚本体不锁住整个 coordinator/HMR；它可以调用 restart 等异步 mutation。后台任务、浏览器和未来更新可交错，单个脚本不是全局事务。

## Runtime API 与资源

`plugins.require()` 对 typed constructor/`{plugin,forkId}` 做当前 catalog identity 检查；地址只用于管理操作，不用来声称具体实例类型。普通 JS 实例没有通用撤销语义，跨 await 使用过期对象的限制需诚实说明。

配置 get/describe/validate/patch/patchField/reset 使用现有配置契约。describe 返回 portable presentation plan，包含准确字段路径与约束；不暴露 raw schema function 或写私有字段。Workbench 使用 exact descriptor、显式 principal 和本地 Cap’n Web session；不验证浏览器登录或 renderer。返回对象/数组 DTO 时使用既有 detachWorkbenchPortableValue 完成普通数据复制与顶层 transport result 释放。

每 run 的 DevScope 在 abort 时关闭 admission、撤回 leases；dispose 等待已接纳 driver 与异步 cleanup。commands/HTTP 合并 run signal；已接纳的 config/lifecycle mutation 沿生产路径 settle，不声称可强制中断。Workbench 仍是原有 RpcStub，所有 RPC 都要求 await，不增加第二层 Proxy 模拟任意方法拦截。直接 Plugin 方法和用户自行创建的 native resource 也不能承诺自动取消/回收。

full-host replacement 先 abort 旧 run、drain 已跟踪资源，再释放旧 root。后续 run 使用新 epoch。任意未协作脚本本体不能被强制终止；旧 run 不转接新 root，执行 slot 在其 settle 前仍被占用。

## 日志

复用当前 RuntimeLogging/RuntimeLogStore。`flushStores()` 只刷 store sink buffer，不依赖 policy persistence；正常 logging.flush 同时刷 store 和 policy。mark 创建 stream 时保留配置的 retention，不凭空创建未配置 default stream。

read 使用真实 epoch/sequence range，分页先有界扫描再过滤；gap/reset/root change 可判断。wait 先 subscribe 再 recheck，区分 available/more/timeout/reset，使用 run/caller 合成 signal。cursor 是时间窗口，不提供因果隔离。

默认 launcher 在启用控制台时添加或复用 bounded store，headless 也可检查日志；显式 custom/silent logging 优先，不运行期重装 LogTape。进程内脚本可以返回有界日志快照，远程 Workbench live stream 继续使用既有控制 session；不提供另一条业务 HTTP/log follow 路由。

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

queued 取消不执行；running 取消保持 cancelling，直到真实代码 settle。断线/超时不自动重放。结果过期与执行结果不确定是不同失败；进程崩溃后的 exactly-once 不作承诺。

## 实现与验证入口

- `packages/runtime/src/dev/`、`src/internal/dev-console.ts`：facade、日志与scope。
- `packages/runtime-dev/src/console.ts`、`src/console/`：Vite接线、队列/协议/IPC。
- `packages/cli/src/dev/client.ts`、`src/commands/dev.ts`：agent交互。
- runtime `tests/dev/console.test.ts` 与 logger tests：真实配置、typed RPC填数据、target identity、signal/drain和cursor。
- runtime-dev console tests：重复请求、取消、保留预算、JSON与socket边界、真实CLI互操作。
- static/dynamic `tests/vite-console.test.ts` 与共享Vite scenario：跨调用状态、工作区源码/HMR、先提交后观察与先观察后提交、host replacement和清理。

修改协议、loader admission、日志buffer或public types时，执行直接owner测试和类型检查；涉及testing共享边界时运行testing-v2 gate，再按仓库要求完成稳定验证。

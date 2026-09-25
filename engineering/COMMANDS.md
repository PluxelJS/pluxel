# Commands 集成边界

`@pluxel/commands` 拥有 transport-neutral command kernel。作者与宿主用法见 [Commands](../docs/runtime/commands.md)，完整 API 见 [package README](../packages/commands/README.md)，parser/projection/performance 决策见 [package design](../packages/commands/docs/DESIGN.md)。本页只定义 Host 集成与 lifecycle。

## Root publication

`@pluxel/services/commands` 的 `commands()` 安装一个空 root registry，Plugin 通过 `ctx.require(Commands)` 获得 owner view。List/snapshot/subscription/execute 委托同一 registry，不复制 revision 或 listeners。

`register()` 返回固定本次发布的 typed command 句柄与 disposer，并绑定注册者 effects。旧句柄在撤销后永久失效；动态名称调用才跟随当前目录。执行返回 `Result<T, CommandFailure>`，持有 owner invocation gate；generation stop 关闭 admission、abort 合成 signal、等待调用退出，再 drain effects。手动 dispose 只撤销 publication，不取消已接纳调用、不关闭 sibling admission。

管理命令由 `@pluxel/services/management/commands` 的 `managementCommands()` 显式安装，`servicesPreset()` 选择它；通用 Commands 不加载管理面。Handler 委托 Host 用例，不复制 start/stop/graph。

## Carrier publication

Root catalog 与 carrier exposure 是两个显式选择。Provider 使用 `createMount<CarrierContext>()`，通过 caller-bound `bind()` 接收 exact `DirectCommand`，固定 provider 与 publication owner generation，并把同步 router/SDK registration cleanup 归入 caller effects。

Mount 没有第二个 registry、name lookup、snapshot 或 caller-supplied owner。其返回值是 disposer，不是 executable command；registry 句柄不能充当直接 route identity，类型与运行期边界都要拒绝误用。

`createArgvRouter()` 只拥有 grammar、routing 和不可信 candidate construction。Carrier 完成授权、构造 invocation Context，再调用 mounted command；先处理 Err，再呈现 Ok 的业务值。presentation/error rendering 也在该 execution 内结算，确保双方 admission 保持有效。扩展 Context 的命令只进入对应 carrier，不能进入要求 common `CommandContext` 的 root catalog。

Host 拥有 exposure、principal、permission、confirmation、audit 与 registration lifetime。关闭 carrier 不创建 server/model client/watcher。CLI 是开发构建工具，不自动连接在线 command catalog；在线检查使用 [devconsole](DEV_CONSOLE.md)。

## Pi 与 MCP 发布

`PiAgentPlugin.expose()` 将单个 Command 发布到 Pi 的显式目录；`createSession({ tools })` 固定本次会话可选的定义或发布名称。Pi 不查询 root catalog，也不依赖 AgentTools。会话创建和每次工具调用重新检查授权；已发布名称固定到原 publication，不跟随同名替换。发布者与 Pi provider 的 invocation gate 覆盖 context、授权、执行和呈现。直接工具在会话内串行；跨会话并发归业务服务。

`@pluxel/services/mcp` 是显式安装的 SDK Server 适配。Host 提供 transport 和每次请求的已认证 principal；Plugin 通过 `ctx.require(Mcp).expose(command)` 发布。MCP 的发现和调用都重新检查当前授权，调用还先构造可信业务 context。发布者与 MCP service 的 owner gate 持续到输出投影完成；撤销阻止新调用，已接纳的调用继续结算。关闭服务移除自己安装的 SDK handlers，不关闭 Host 持有的 transport。

两种载体都先检查 Command Result，再投影原生协议结果。普通成功值只在出口编码；输出编码、尺寸和 MCP output schema 失败不重跑 Command。Pi 的工具选择与 MCP 的当前授权由各自应用入口负责。

`@pluxel/services/rpc` 是显式安装的 Command 目录。工具链将静态发布点与 Command 对象生成绑定事实；Host 在图提交时登记该 candidate 的原始制品和 definition，`RpcService` 按真实 owner 与制品对象身份核对发布。会话由可信 root 入口用精确 `{ id, hash }` 创建，固定 generation；发现和调用都执行当前授权，RPC Result 投影为有界 JSON。HTTP carrier 与隔离 executor 仍在内部验证，当前运行边界见[执行器文档](RPC_EXECUTOR.md)，剩余门槛见[提案](proposals/AGENT_RPC_COMMANDS.md)。

公开会话类型只提供发现、调用、缩权与关闭；HTTP 回复占用和 executor 工作跟踪由内部会话契约使用，不成为应用调用面。

## 实现与验证

- `packages/commands/src/schema.ts`、`compile.ts`、`define.ts`：schema/codec、plan、call-time validation。
- 同目录 `registry.ts`、`argv/`：publication、dynamic dispatch 与 argv grammar。
- `packages/services/src/commands/service.ts`：root view、caller-bound mount 与 invocation ownership。
- `plugins/pi-agent/src/tool-adapter.ts`：Pi SDK schema/name 与结果投影。
- `packages/services/src/mcp/`：SDK Server handlers、owner publication 与输出投影。

修改集成时验证 cached handle、manual dispose 与 stop 的差异、双 owner withdrawal、扩展 Context 限制，以及发现和执行的当前授权。纯 parser/codec 行为在 Commands 包内验证。

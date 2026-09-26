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

## Cap’n Web 适配

Command 内核不拥有远程会话。需要远程调用时，由明确选择的 Command 组成原生 Cap’n Web `RpcTarget` class；每个方法复用 Command 输入校验与执行 Result，并在出口投影可传输的数据。实例由宿主绑定可信 context，远程输入不能提供身份、资源 owner 或策略。

普通领域能力继续直接使用 Cap’n Web `RpcTarget`。连接、认证、授权与会话清理属于安装该 target 的宿主，不进入 Commands 的定义契约，也不创建另一套目录和分派协议。

## 实现与验证

- `packages/commands/src/schema.ts`、`compile.ts`、`define.ts`：schema/codec、plan、call-time validation。
- 同目录 `registry.ts`、`argv/`：publication、dynamic dispatch 与 argv grammar。
- `packages/services/src/commands/service.ts`：root view、caller-bound mount 与 invocation ownership。
- `packages/services/src/capnweb.ts`：选定 Command 到原生 `RpcTarget` 方法的适配。

修改集成时验证 cached handle、manual dispose 与 stop 的差异、双 owner withdrawal、扩展 Context 限制，以及发现和执行的当前授权。纯 parser/codec 行为在 Commands 包内验证。

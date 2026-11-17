# Commands 集成边界

`@pluxel/commands` 拥有 transport-neutral command kernel 和协议投影；Services 拥有 Host 集成、publication 和生命周期。公开用法见 [Commands](../docs/plugin-development/commands.md)，定义、parser 和性能设计见 [package design](../packages/commands/docs/DESIGN.md)，API 清单见 [package README](../packages/commands/README.md)。

## Root publication

`@pluxel/services/commands` 的 `commands()` 安装空 root registry。Plugin 经 `ctx.require(Commands)` 取得 owner view；list、snapshot、subscription 和 execute 委托同一 registry。

`register()` 返回 typed command handle 和 disposer，并把撤销登记到 owner effects。handle 固定本次 publication，撤销后永久失效；动态名称调用跟随当前目录。执行返回 `Result<T, CommandFailure>` 并持有 owner invocation gate。generation stop 关闭 admission、abort 合成 signal、等待调用退出，再 drain effects。手动 dispose 只撤销 publication，已接纳调用与 sibling admission 继续结算。

`managementCommands()` 由 `/management/commands` 显式安装，官方 preset 选择它。handler 委托 Host 用例，通用 Commands 不加载管理面。

## Carrier publication

root catalog 和 carrier exposure 各自显式选择。provider 创建 `createMount<CarrierContext>()`，caller-bound `bind(command, { install, handle? })` 接收 exact `DirectCommand`，固定 provider 和 publication owner generation，把同步 router/SDK registration cleanup 登记到 caller effects。

mount 返回 disposer，保留单一 registry。installer 得到带 `mounted: true` 的 `MountedCommand`；registry handle 和 mounted endpoint 在类型及运行时均不能作为新的 direct definition。`snapshotCommand()` 统一校验描述并取得执行快照，保留原 publication 撤回限制。

`toCli()` 在定义侧编译 argv 投影；`createArgvRouter()` 在 bind 时处理发布、冲突和不可信 candidate。carrier 的 `handle(command, candidate, context)` 拥有授权、业务 Context、执行和呈现，整个 callback 在双方 admission 内结算。candidate 为 unknown，由所选 Command 校验；省略 handle 时直接执行原 Command。需要 owner 资源的结果投影也应放在 handle 内，endpoint 返回后的处理已离开该保护范围。

Services 与 kernel 共用内部 Result 校验：合法 Result 保留，未知异常或非法返回监督为 INTERNAL。扩展 Context 的命令只进入对应 carrier，root catalog 要求 common `CommandContext`。

exposure、principal、permission、confirmation、audit 和 registration lifetime 由宿主拥有。carrier 投影本身不创建 server、model client 或 watcher。CLI 是开发构建工具；在线 command 检查使用 [devconsole](DEV_CONSOLE.md)。

## Cap’n Web 适配

`@pluxel/commands/capnweb` 的 `toCapnweb()` 把选定 Command 映射为原生 `RpcTarget` class 的 prototype 方法。每个方法共用 Command 输入校验和执行 Result，出口投影普通 JSON；宿主为实例绑定可信 Context，远程输入不能选择身份、owner 或策略。普通领域能力也可直接使用 `RpcTarget`，会话、认证、授权与清理由安装 target 的宿主负责。

创建 class 时拒绝客户端 stub 保留方法名和 Cap’n Web 无法保真的静态字段；动态字段由应用避开这些键。出口检查特殊键和实际编码能力，拒绝会丢字段或超深的结果。输入校验发生在传输解码之后，上游已丢弃的字段不在可检查范围内。

原生 `RpcStub` 回归覆盖方法和 Context 隔离，HTTP batch 回归覆盖 wire 调用，serialize/deserialize 覆盖数据往返。HTTP batch 是一次性会话：批次内可并行调用，完成后释放 stub。框架没有独立 Command RPC 发现或模型运行时。

## MCP 投影

`@pluxel/commands/mcp` 的 `toMcp()` 只产生选定 Command 的 MCP SDK `Tool` 描述和 `call()`。每次调用显式传入可信 Context，Command 校验输入，成功值转成 JSON 文本，Err 转为 `isError` 并移除本地 cause。

应用选择工具并接到 SDK handler，拥有 server、认证、会话和 transport。需要 generation admission 时，用 caller-bound mount 的 handle 包住调用及输出映射。MCP 和 Cap’n Web peers 均可选；MCP SDK 仅作类型依赖，默认入口与 MCP 入口不加载 Cap’n Web。

## 实现与验证

- `packages/commands/src/schema.ts`、`compile.ts`、`define.ts`：schema、codec、plan、调用校验。
- 同目录 `snapshot.ts`、`registry.ts`、`argv/`：快照、publication、动态 dispatch 和 argv grammar。
- `packages/services/src/commands/service.ts`：owner view、mount、双 owner invocation。
- `packages/commands/src/adapters/{capnweb,mcp}.ts`：协议投影。

publication 回归覆盖缓存 handle、manual dispose/stop 差异、双方撤回和扩展 Context 限制。Cap’n Web 覆盖原生方法、服务端 Context、Result 和 wire 编码；MCP 使用 SDK 原生请求与内存传输检查 Tool/CallToolResult。parser/codec 在 Commands 包内验证。

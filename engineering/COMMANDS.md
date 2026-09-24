# Commands 集成边界

`@pluxel/commands` 拥有 transport-neutral command kernel。作者与宿主用法见 [Commands](../docs/runtime/commands.md)，完整 API 见 [package README](../packages/commands/README.md)，parser/projection/performance 决策见 [package design](../packages/commands/docs/DESIGN.md)。本页只定义 Host 集成与 lifecycle。

## Root publication

`@pluxel/services/commands` 的 `commands()` 安装一个空 root registry，Plugin 通过 `ctx.require(Commands)` 获得 owner view。List/snapshot/subscription/execute 委托同一 registry，不复制 revision 或 listeners。

`register()` 返回 typed installed command 与 disposer，并绑定注册者 effects。执行持有 owner invocation gate；generation stop 关闭 admission、abort 合成 signal、等待调用退出，再 drain effects。手动 dispose 只撤销 publication，不取消已接纳调用、不关闭 sibling admission。

管理命令由 `@pluxel/services/management/commands` 的 `managementCommands()` 显式安装，`servicesPreset()` 选择它；通用 Commands 不加载管理面。Handler 委托 Host 用例，不复制 start/stop/graph。

## Carrier publication

Root catalog 与 carrier exposure 是两个显式选择。Provider 使用 `createMount<CarrierContext>()`，通过 caller-bound `bind()` 接收 exact `DirectCommand`，固定 provider 与 publication owner generation，并把同步 router/SDK registration cleanup 归入 caller effects。

Mount 没有第二个 registry、name lookup、snapshot 或 caller-supplied owner。其返回值是 disposer，不是 executable installed command；compatible-replacement registry handle 不能充当 route identity，类型与运行期边界都要拒绝误用。

`createArgvRouter()` 只拥有 grammar、routing 和不可信 candidate construction。Carrier 完成授权、构造 invocation Context，再调用 mounted command；presentation/error rendering 也在该 execution 内结算，确保双方 admission 保持有效。扩展 Context 的命令只进入对应 carrier，不能进入要求 common `CommandContext` 的 root catalog。

Host 拥有 exposure、principal、permission、confirmation、audit 与 registration lifetime。关闭 carrier 不创建 server/model client/watcher。CLI 是开发构建工具，不自动连接在线 command catalog；在线检查使用 [devconsole](DEV_CONSOLE.md)。

## Agent tools

`@pluxel/agent-tools` 是普通可选 Plugin；Toolsets 与 Agent assignments 使用标准 Plugin config，ConfigService 继续唯一持久化、校验与更新。缺失 command name 保留，重新发布同名 command 后恢复可用。

`AgentToolsPlugin.catalog(agentId)` 同时用于 list 与 execute：publication 前过滤，调用时重新检查 assignment，再交给 root registry。绕过它直接执行 root catalog 会绕过 Agent allowlist，只能用于另行授权的宿主路径。

`{ catalogRevision, policyRevision }` 与 subscription 使 carrier 在 command 变化或配置更新时重投影，不建立第二套 registry。Policy 修改只约束之后接纳的调用，不取消已接纳工作。Agent adapters 投影标准 read-only/destructive/idempotent/open-world annotations，不让 Runtime 安装 Agent provider、Toolset store 或专用管理 API。

## 实现与验证

- `packages/commands/src/schema.ts`、`compile.ts`、`define.ts`：schema/codec、plan、call-time validation。
- 同目录 `registry.ts`、`argv/`：publication、dynamic dispatch 与 argv grammar。
- `packages/services/src/commands/service.ts`：root view、caller-bound mount 与 invocation ownership。
- `plugins/agent-tools/src/index.ts`：配置投影和调用时 enforcement。
- `plugins/pi-agent/src/tool-adapter.ts`：provider schema/name projection；仍通过 bound catalog 调用。

修改集成时验证 cached handle、manual dispose 与 stop 的差异、双 owner withdrawal、扩展 Context 限制，以及 allowlist 在发布和执行两处生效。纯 parser/codec 行为在 Commands 包内验证。
